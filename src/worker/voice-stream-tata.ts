// Tata Teleservices bidirectional audio streaming endpoint — LIVE bridge.
//
// Tata's wire format is identical to Twilio Media Streams. This module:
//
//   1. Accepts a WS upgrade from Tata at /voice/stream/tata.
//   2. Authenticates via the per-tenant streaming API key (Bearer header,
//      X-Api-Key header, or ?key= query).
//   3. Parses Tata's envelope: connected → start → media → stop/dtmf/mark.
//   4. Decodes each μ-law/8 kHz/base64 frame, resamples to linear16/16 kHz,
//      and feeds it into Deepgram Flux for streaming STT.
//   5. On end-of-turn, runs an LLM round (OpenAI Responses API thread if
//      OPENAI_API_KEY is set, otherwise Workers AI Llama 3.1 8B).
//   6. Synthesises the agent's reply via Aura/Gemini, resamples to 8 kHz,
//      μ-law encodes, chunks to 160-byte (20 ms) frames, and sends each one
//      back as a `media` event followed by a `mark` for sync.
//   7. Detects barge-in: on first STT partial while playing, sends Tata a
//      `clear` event and aborts the in-flight LLM turn.
//
// Per-tenant agent selection: the most-recently-updated agent for the tenant
// supplies the voice + system prompt. If the tenant has no agents, falls back
// to a friendly built-in assistant.

import { FluxStt, OpenAiLlm, WorkersAiLlm, synthesizePcm } from './adapters';
import { hashApiKey } from './auth';
import { verifyStreamToken } from './stream-token';
import {
  base64ToBytes,
  bytesToBase64,
  decodeMulaw,
  encodeMulaw,
  resampleLinear16,
} from './codecs';
import { err } from './util';
import type { LlmPort } from '../engine/ports';
import type { Message, SttEvent } from '../engine/types';

interface StartEvent {
  event: 'start';
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid?: string;
    accountSid?: string;
    callSid?: string;
    from?: string;
    to?: string;
    direction?: 'inbound' | 'outbound';
    mediaFormat?: { encoding?: string; sampleRate?: number; bitRate?: number; bitDepth?: number };
    customParameters?: Record<string, string>;
  };
}

interface MediaInEvent {
  event: 'media';
  streamSid?: string;
  sequenceNumber?: string;
  media?: { chunk?: string | number; timestamp?: string; payload?: string };
}

interface DtmfEvent {
  event: 'dtmf';
  streamSid?: string;
  sequenceNumber?: string;
  dtmf?: { digit?: string };
}

interface StopEvent {
  event: 'stop';
  streamSid?: string;
  sequenceNumber?: string;
  stop?: { accountSid?: string; callSid?: string; reason?: string };
}

interface MarkAckEvent {
  event: 'mark';
  streamSid?: string;
  sequenceNumber?: string;
  mark?: { name?: string };
}

type IncomingEvent =
  | { event: 'connected' }
  | StartEvent
  | MediaInEvent
  | DtmfEvent
  | StopEvent
  | MarkAckEvent;

function extractApiKey(request: Request): string | null {
  const url = new URL(request.url);
  const qp = url.searchParams.get('key');
  if (qp) return qp;
  const xkey = request.headers.get('x-api-key');
  if (xkey) return xkey;
  const authz = request.headers.get('authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim();
  return null;
}

interface AuthResult { tenantId: string; enabled: boolean }
async function authenticateStream(env: Env, key: string): Promise<AuthResult | null> {
  const hash = await hashApiKey(key);
  const row = await env.DB.prepare(
    'SELECT tenant_id, stream_enabled FROM voice_integrations WHERE stream_api_key_hash = ?',
  )
    .bind(hash)
    .first<{ tenant_id: string; stream_enabled: number }>();
  if (!row) return null;
  return { tenantId: row.tenant_id, enabled: !!row.stream_enabled };
}

interface AgentConfig {
  id: string | null;
  voiceId: string;
  systemPrompt: string;
  llmTier: 'workers_ai' | 'openai';
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly voice assistant on a phone call. Speak in one or two short, natural sentences. Avoid markdown.';

interface AgentRoutingInputs {
  explicitAgentId: string | null;   // from start.customParameters.agentId
  ourDid: string | null;            // our DID on this call — `to` if inbound, `from` if outbound
}

function rowToAgentConfig(row: {
  id: string; voice: string; system_prompt_template: string; llm_tier_policy: string;
}): AgentConfig {
  let tier: 'workers_ai' | 'openai' = 'workers_ai';
  try {
    const p = JSON.parse(row.llm_tier_policy) as { tier?: string };
    if (p?.tier === 'openai') tier = 'openai';
  } catch { /* default tier */ }
  return {
    id: row.id,
    voiceId: row.voice || 'aura2en:asteria',
    systemPrompt: row.system_prompt_template || DEFAULT_SYSTEM_PROMPT,
    llmTier: tier,
  };
}

/**
 * Three-tier routing precedence — works for both inbound and outbound calls:
 *   1. start.customParameters.agentId — explicit per-call override.
 *      Set this in your carrier's Stream/Channel config when you want a
 *      specific agent for a specific campaign.
 *   2. Match our DID against agents.inbound_dids:
 *      - inbound calls: our DID is `start.to`
 *      - outbound calls: our DID is `start.from` (the caller_id we dialed from)
 *   3. Fall back to the most-recently-updated agent for the tenant.
 *      Empty tenants get the built-in friendly assistant.
 */
async function pickAgentForCall(
  env: Env,
  tenantId: string,
  inputs: AgentRoutingInputs,
): Promise<AgentConfig> {
  // 1. Explicit agentId from customParameters
  if (inputs.explicitAgentId) {
    const row = await env.DB.prepare(
      `SELECT id, voice, system_prompt_template, llm_tier_policy
       FROM agents WHERE id = ? AND tenant_id = ?`,
    )
      .bind(inputs.explicitAgentId, tenantId)
      .first<{ id: string; voice: string; system_prompt_template: string; llm_tier_policy: string }>();
    if (row) return rowToAgentConfig(row);
    console.warn('[tata] explicit agentId', inputs.explicitAgentId, 'not found for tenant', tenantId);
  }

  // 2. Match our DID (direction-aware: `to` for inbound, `from` for outbound)
  if (inputs.ourDid) {
    const normalized = inputs.ourDid.replace(/[^\d]/g, ''); // digits-only for comparison
    const candidates = await env.DB.prepare(
      `SELECT id, voice, system_prompt_template, llm_tier_policy, inbound_dids
       FROM agents WHERE tenant_id = ? AND inbound_dids != '[]'`,
    )
      .bind(tenantId)
      .all<{ id: string; voice: string; system_prompt_template: string; llm_tier_policy: string; inbound_dids: string }>();
    for (const c of candidates.results) {
      try {
        const dids = JSON.parse(c.inbound_dids) as string[];
        for (const did of dids) {
          if (did.replace(/[^\d]/g, '') === normalized) return rowToAgentConfig(c);
        }
      } catch { /* skip bad json */ }
    }
  }

  // 3. Tenant default
  const row = await env.DB.prepare(
    `SELECT id, voice, system_prompt_template, llm_tier_policy
     FROM agents WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(tenantId)
    .first<{ id: string; voice: string; system_prompt_template: string; llm_tier_policy: string }>();
  if (row) return rowToAgentConfig(row);

  return {
    id: null,
    voiceId: 'aura2en:asteria',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    llmTier: 'workers_ai',
  };
}

interface SendCtx { sequence: number; streamSid: string }

function sendEvent(ws: WebSocket, ctx: SendCtx, body: Record<string, unknown>) {
  ctx.sequence++;
  try {
    ws.send(JSON.stringify({ ...body, sequenceNumber: String(ctx.sequence), streamSid: ctx.streamSid }));
  } catch { /* socket closed */ }
}

/** Send one μ-law buffer split into 160-byte (20 ms) media frames. */
function sendMediaChunks(ws: WebSocket, ctx: SendCtx, ulaw: Uint8Array, aborted: () => boolean): void {
  const FRAME = 160;
  let chunkIdx = 0;
  for (let off = 0; off < ulaw.length; off += FRAME) {
    if (aborted()) return;
    chunkIdx++;
    let frame = ulaw.subarray(off, off + FRAME);
    if (frame.length < FRAME) {
      const padded = new Uint8Array(FRAME);
      padded.set(frame);
      padded.fill(0xff, frame.length);
      frame = padded;
    }
    sendEvent(ws, ctx, {
      event: 'media',
      media: { payload: bytesToBase64(frame), chunk: chunkIdx },
    });
  }
}

export async function handleTataStream(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return err(426, 'expected WebSocket upgrade');
  }
  // Two auth paths: a per-call stream token (Twilio inbound/outbound — minted by
  // the TwiML webhook / outbound adapter, since Twilio's <Stream> can't send
  // headers), or the long-lived streaming API key (raw-PCM / direct carriers).
  let resolvedAuth: AuthResult | null = null;
  let tokenAgentId: string | null = null;
  const token = new URL(request.url).searchParams.get('token');
  if (token) {
    const secret = (env as unknown as { STREAM_TOKEN_SECRET?: string }).STREAM_TOKEN_SECRET;
    const claims = secret ? await verifyStreamToken(token, secret) : null;
    if (!claims) return err(401, 'invalid or expired stream token');
    resolvedAuth = { tenantId: claims.tenantId, enabled: true };
    tokenAgentId = claims.agentId;
  } else {
    const apiKey = extractApiKey(request);
    if (!apiKey) return err(401, 'missing API key (Bearer / X-Api-Key / ?key=)');
    resolvedAuth = await authenticateStream(env, apiKey);
    if (!resolvedAuth) return err(401, 'unknown API key');
    if (!resolvedAuth.enabled) return err(403, 'streaming is disabled for this tenant');
  }
  const auth = resolvedAuth;

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const ctx: SendCtx = { sequence: 0, streamSid: '' };
  const env2 = env as unknown as { OPENAI_API_KEY?: string; GOOGLE_AI_API_KEY?: string };

  // Agent + LLM + STT all get late-initialized at `start` time, because the
  // routing decision needs the `to` field and customParameters.agentId.
  let agent: AgentConfig | null = null;
  let llm: LlmPort | null = null;
  let stt: FluxStt | null = null;

  // --- Per-connection state --------------------------------------------
  const state = {
    streamSid: '',
    callDbId: '',
    callSid: null as string | null,
    from: null as string | null,
    to: null as string | null,
    startedAt: 0,
    mediaIn: 0,
    history: [] as Message[],
    transcripts: [] as { role: 'user' | 'assistant'; text: string; t: number }[],
    isPlaying: false,
    turnAbort: null as AbortController | null,
    closed: false,
    sttReady: false,
  };

  // --- Agent turn driver -----------------------------------------------
  async function runAgentTurn(precommittedUserText?: string): Promise<void> {
    if (state.closed || !agent || !llm) return;
    state.turnAbort?.abort();
    state.turnAbort = new AbortController();
    const { signal } = state.turnAbort;
    state.isPlaying = true;

    try {
      let response = '';
      for await (const delta of llm.generate(state.history, { signal })) {
        if (signal.aborted) return;
        if (delta.type === 'text') response += delta.text;
        if (delta.type === 'done') break;
      }
      response = response.trim();
      if (signal.aborted || state.closed) return;
      if (!response) {
        state.isPlaying = false;
        return;
      }

      state.history.push({ role: 'assistant', content: response });
      state.transcripts.push({ role: 'assistant', text: response, t: Date.now() });
      console.log('[tata]', auth.tenantId, 'assistant:', response.slice(0, 120));

      const { pcm, sampleRate } = await synthesizePcm({
        ai: env.AI,
        googleApiKey: env2.GOOGLE_AI_API_KEY,
        voiceId: agent.voiceId,
        text: response,
      });
      if (signal.aborted || state.closed) return;

      const pcm8k = resampleLinear16(pcm, sampleRate, 8000);
      const ulaw = encodeMulaw(pcm8k);
      sendMediaChunks(server, ctx, ulaw, () => signal.aborted || state.closed);
      if (signal.aborted || state.closed) return;
      sendEvent(server, ctx, {
        event: 'mark',
        mark: { name: `turn-${state.history.length}` },
      });
    } catch (e) {
      console.error('[tata] turn failed', e);
    } finally {
      if (precommittedUserText && state.history.length > 0) {
        const last = state.history[state.history.length - 1]!;
        if (last.role === 'user' && last.content !== precommittedUserText) {
          // history was modified; nothing else to do.
        }
      }
      state.isPlaying = false;
    }
  }

  // --- Incoming media → STT ---
  function pushAudioToStt(payloadB64: string) {
    if (!state.sttReady || state.closed || !stt) return;
    try {
      const ulawBytes = base64ToBytes(payloadB64);
      const pcm8k = decodeMulaw(ulawBytes);
      const pcm16k = resampleLinear16(pcm8k, 8000, 16000);
      stt.sendAudio(new Uint8Array(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength));
    } catch (e) {
      console.warn('[tata] audio decode failed', (e as Error).message);
    }
  }

  function initializeAgentForCall(m: StartEvent): void {
    if (agent || !m.start) return;
    // Routing inputs from Tata's start envelope. Our DID on this call is
    // `to` when someone is calling us, `from` when we're calling them out.
    const params = m.start.customParameters ?? {};
    // Tata's `custom_identifier` lands here as `customParameters.custom_identifier`.
    // We stamp it with JSON { agentId } from the click-to-call proxy so the
    // outbound stream routes back to the originating agent.
    let explicitAgentId: string | null = (params.agentId as string | undefined) ?? null;
    if (!explicitAgentId && typeof params.custom_identifier === 'string') {
      try {
        const parsed = JSON.parse(params.custom_identifier) as { agentId?: string };
        if (parsed?.agentId) explicitAgentId = parsed.agentId;
      } catch { /* not JSON — ignore */ }
    }
    // Twilio stream tokens carry the resolved agent (the TwiML webhook already
    // did DID→agent routing); honor it when the carrier sent no override.
    if (!explicitAgentId) explicitAgentId = tokenAgentId;
    const direction = m.start.direction;
    const ourDid =
      direction === 'outbound' ? (m.start.from ?? null) : (m.start.to ?? null);

    // pickAgentForCall is async; resolve and then build the LLM + STT.
    void pickAgentForCall(env, auth.tenantId, { explicitAgentId, ourDid }).then((picked) => {
      if (state.closed) return;
      agent = picked;
      state.history.push({ role: 'system', content: picked.systemPrompt });

      if (picked.llmTier === 'openai' && env2.OPENAI_API_KEY) {
        llm = new OpenAiLlm(env2.OPENAI_API_KEY, 'gpt-4o-mini', {
          onError: (msg, data) => console.warn('[tata-llm]', msg, data),
        });
      } else {
        llm = new WorkersAiLlm(env.AI, {
          onError: (msg, data) => console.warn('[tata-llm]', msg, data),
        });
      }

      stt = new FluxStt(
        env.AI,
        '16000',
        (msg, data) => console.warn('[tata-stt]', msg, data),
        0.55,
        2500,
      );
      stt.onEvent((e: SttEvent) => {
        if (state.closed) return;
        if (e.type === 'partial') {
          if (state.isPlaying && e.text.trim().length > 0) {
            sendEvent(server, ctx, { event: 'clear' });
            state.turnAbort?.abort();
            state.isPlaying = false;
          }
          return;
        }
        if (e.type === 'endOfTurn') {
          const userText = e.text.trim();
          if (!userText) return;
          state.history.push({ role: 'user', content: userText });
          state.transcripts.push({ role: 'user', text: userText, t: Date.now() });
          console.log('[tata]', auth.tenantId, 'user:', userText.slice(0, 120));
          void runAgentTurn(userText);
        }
      });
      state.sttReady = true;
      console.log('[tata]', auth.tenantId, 'agent picked:', picked.id ?? '(default)');

      // Persist call row with the resolved agent_id now that we know it.
      env.DB.prepare(
        `UPDATE calls SET agent_id = ? WHERE id = ?`,
      ).bind(picked.id, state.callDbId).run().catch(() => {});

      // Kick off the greeting now — system prompt is in history, agent is ready.
      state.history.push({
        role: 'user',
        content: '[Call just connected. Greet the caller briefly and ask how you can help.]',
      });
      void runAgentTurn();
    }).catch((e) => console.error('[tata] agent init failed', e));
  }

  // --- Tata → us ---
  server.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    let msg: IncomingEvent;
    try { msg = JSON.parse(ev.data) as IncomingEvent; } catch { return; }
    if (!msg?.event) return;

    switch (msg.event) {
      case 'connected':
        // No required response.
        break;

      case 'start': {
        const m = msg as StartEvent;
        state.streamSid = m.streamSid ?? m.start?.streamSid ?? '';
        ctx.streamSid = state.streamSid;
        state.callSid = m.start?.callSid ?? null;
        state.from = m.start?.from ?? null;
        state.to = m.start?.to ?? null;
        state.startedAt = Date.now();
        state.callDbId = `tata-${state.streamSid}`.slice(0, 64);
        console.log('[tata]', auth.tenantId, 'start', {
          streamSid: state.streamSid,
          callSid: state.callSid,
          from: state.from,
          to: state.to,
          direction: m.start?.direction,
          customParameters: m.start?.customParameters,
        });
        env.DB.prepare(
          `INSERT INTO calls
            (id, tenant_id, agent_id, caller_ref, started_at, status, end_reason, carrier_call_id)
           VALUES (?, ?, NULL, ?, ?, 'active', NULL, ?)`,
        )
          .bind(
            state.callDbId,
            auth.tenantId,
            `${state.from ?? '?'}→${state.to ?? '?'}`,
            state.startedAt,
            state.callSid,
          )
          .run()
          .catch(() => { /* duplicate id on reconnect is fine */ });
        // Late-init: agent is picked from start envelope, then STT/LLM
        // come up, then we kick off the greeting turn.
        initializeAgentForCall(m);
        break;
      }

      case 'media': {
        state.mediaIn++;
        const payload = (msg as MediaInEvent).media?.payload;
        if (payload) pushAudioToStt(payload);
        break;
      }

      case 'dtmf': {
        const digit = (msg as DtmfEvent).dtmf?.digit;
        if (digit) {
          console.log('[tata]', auth.tenantId, 'dtmf', digit);
          // Treat DTMF as a user "spoke" event so the agent can branch on it.
          state.history.push({ role: 'user', content: `[DTMF pressed: ${digit}]` });
          void runAgentTurn();
        }
        break;
      }

      case 'mark': {
        const name = (msg as MarkAckEvent).mark?.name;
        if (name) console.log('[tata]', auth.tenantId, 'mark ack', name);
        break;
      }

      case 'stop': {
        const reason = (msg as StopEvent).stop?.reason ?? 'remote stop';
        console.log('[tata]', auth.tenantId, 'stop', reason);
        finalize(`tata:${reason}`);
        try { server.close(1000, 'stop'); } catch { /* ignore */ }
        break;
      }
    }
  });

  server.addEventListener('close', () => finalize('ws_close'));
  server.addEventListener('error', () => finalize('ws_error'));

  function finalize(reasonTag: string) {
    if (state.closed) return;
    state.closed = true;
    state.turnAbort?.abort();
    try { stt?.close(); } catch { /* ignore */ }
    if (!state.streamSid || state.startedAt === 0) return;
    const durationS = Math.round((Date.now() - state.startedAt) / 1000);
    // Persist transcript + close the call row in one batch.
    const turnsJson = JSON.stringify(state.transcripts.map((t) => ({ role: t.role, text: t.text, t: t.t })));
    env.DB.batch([
      env.DB.prepare(
        `UPDATE calls SET ended_at = ?, duration_s = ?, status = 'ended',
                  end_reason = COALESCE(end_reason, ?)
         WHERE id = ?`,
      ).bind(Date.now(), durationS, reasonTag.slice(0, 64), state.callDbId),
      env.DB.prepare(
        `INSERT OR REPLACE INTO transcripts (call_id, tenant_id, turns)
         VALUES (?, ?, ?)`,
      ).bind(state.callDbId, auth.tenantId, turnsJson),
    ]).catch((e) => console.warn('[tata] finalize batch failed', e));
  }

  return new Response(null, { status: 101, webSocket: client });
}
