// Tata Teleservices bidirectional audio streaming endpoint.
//
// Tata's wire format is essentially Twilio Media Streams (same envelope,
// same μ-law 8 kHz / base64 payload, same media/start/stop/mark/clear
// vocabulary). This module:
//
//   1. Accepts a WS upgrade from Tata at /voice/stream/tata.
//   2. Authenticates via the streaming API key (Bearer header, X-Api-Key
//      header, or ?key= query — Tata can use any of them).
//   3. Parses Tata's incoming JSON envelope: connected → start → media+ → stop.
//   4. Greets the caller with a real TTS hello so the carrier-side audio
//      pipeline can be verified end-to-end (codec, chunking, mark/clear).
//   5. Echoes mark acks and tracks DTMF.
//
// What's NOT here yet (iteration 2): bridging the caller's audio into our
// live agent loop (STT → LLM → TTS streaming back). The CallSession Durable
// Object is currently wired to our internal protocol; making it carrier-
// agnostic is a separate refactor.

import { hashApiKey } from './auth';
import { bytesToBase64, encodeMulaw, resampleLinear16 } from './codecs';
import { err } from './util';

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

/**
 * Mu-law silence is 0xff. We send a ½-second silent prelude to ensure the
 * carrier's jitter buffer has audio queued before our TTS lands.
 */
function silenceMulawFrame(samples: number): Uint8Array {
  const out = new Uint8Array(samples);
  out.fill(0xff);
  return out;
}

async function ttsHelloAsMulaw(env: Env): Promise<Uint8Array | null> {
  try {
    const { synthesizePcm } = await import('./adapters');
    const env2 = env as unknown as { GOOGLE_AI_API_KEY?: string };
    const { pcm, sampleRate } = await synthesizePcm({
      ai: env.AI,
      googleApiKey: env2.GOOGLE_AI_API_KEY,
      voiceId: 'aura2en:asteria',
      text: 'Hello. Your stream is connected to calling A I. You can begin speaking after the tone.',
    });
    const pcm8k = resampleLinear16(pcm, sampleRate, 8000);
    return encodeMulaw(pcm8k);
  } catch {
    return null;
  }
}

interface SendCtx {
  sequence: number;
  streamSid: string;
}

function sendEvent(ws: WebSocket, ctx: SendCtx, body: Record<string, unknown>) {
  ctx.sequence++;
  ws.send(JSON.stringify({ ...body, sequenceNumber: String(ctx.sequence), streamSid: ctx.streamSid }));
}

/**
 * Send a μ-law audio buffer as a sequence of 160-byte (20 ms) `media`
 * events. Per Tata's spec, payloads must be a multiple of 160 bytes to
 * avoid gaps; we pad the final partial chunk with μ-law silence (0xff).
 */
function sendMediaChunks(ws: WebSocket, ctx: SendCtx, ulaw: Uint8Array) {
  const FRAME = 160;
  let chunkIdx = 0;
  for (let off = 0; off < ulaw.length; off += FRAME) {
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
  const apiKey = extractApiKey(request);
  if (!apiKey) return err(401, 'missing API key (Bearer / X-Api-Key / ?key=)');
  const auth = await authenticateStream(env, apiKey);
  if (!auth) return err(401, 'unknown API key');
  if (!auth.enabled) return err(403, 'streaming is disabled for this tenant');

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const ctx: SendCtx = { sequence: 0, streamSid: '' };
  const state = {
    streamSid: '' as string,
    callSid: null as string | null,
    from: null as string | null,
    to: null as string | null,
    mediaIn: 0,
    dtmfDigits: [] as string[],
    startedAt: 0,
  };

  let hangup = false;
  async function greet() {
    if (!state.streamSid) return;
    sendMediaChunks(server, ctx, silenceMulawFrame(4000)); // 0.5 s silence
    const hello = await ttsHelloAsMulaw(env);
    if (hello && !hangup) {
      sendMediaChunks(server, ctx, hello);
      sendEvent(server, ctx, { event: 'mark', mark: { name: 'hello-played' } });
    }
  }

  server.addEventListener('message', (e: MessageEvent) => {
    if (typeof e.data !== 'string') return;
    let msg: IncomingEvent;
    try { msg = JSON.parse(e.data) as IncomingEvent; } catch { return; }
    if (!msg?.event) return;

    switch (msg.event) {
      case 'connected':
        // No required response. Carrier expects we'll wait for `start` next.
        break;

      case 'start': {
        const m = msg as StartEvent;
        state.streamSid = m.streamSid ?? m.start?.streamSid ?? '';
        ctx.streamSid = state.streamSid;
        state.callSid = m.start?.callSid ?? null;
        state.from = m.start?.from ?? null;
        state.to = m.start?.to ?? null;
        state.startedAt = Date.now();
        console.log('[tata]', auth.tenantId, 'start', {
          streamSid: state.streamSid,
          callSid: state.callSid,
          from: state.from,
          to: state.to,
          direction: m.start?.direction,
          encoding: m.start?.mediaFormat?.encoding,
        });
        // Persist a call row so the tenant sees it in their dashboard.
        env.DB.prepare(
          `INSERT INTO calls
            (id, tenant_id, agent_id, caller_ref, started_at, status, end_reason)
           VALUES (?, ?, NULL, ?, ?, 'active', NULL)`,
        )
          .bind(
            `tata-${state.streamSid}`.slice(0, 64),
            auth.tenantId,
            `${state.from ?? '?'}→${state.to ?? '?'}`,
            state.startedAt,
          )
          .run()
          .catch(() => { /* dup id on reconnect is fine */ });
        // Kick off greeting asynchronously — don't block the message handler.
        greet().catch((e2) => console.error('[tata] greet failed', e2));
        break;
      }

      case 'media': {
        state.mediaIn++;
        // v1 stub: count frames. v2 will pipe these through STT/LLM/TTS.
        if (state.mediaIn % 250 === 0) {
          console.log('[tata]', auth.tenantId, `received ${state.mediaIn} media frames`);
        }
        break;
      }

      case 'dtmf': {
        const digit = (msg as DtmfEvent).dtmf?.digit;
        if (digit) {
          state.dtmfDigits.push(digit);
          console.log('[tata]', auth.tenantId, 'dtmf', digit);
        }
        break;
      }

      case 'mark': {
        const name = (msg as MarkAckEvent).mark?.name;
        console.log('[tata]', auth.tenantId, 'mark ack', name);
        break;
      }

      case 'stop': {
        const reason = (msg as StopEvent).stop?.reason ?? 'remote stop';
        console.log('[tata]', auth.tenantId, 'stop', reason);
        hangup = true;
        const durationS = Math.round((Date.now() - state.startedAt) / 1000);
        env.DB.prepare(
          `UPDATE calls SET ended_at = ?, duration_s = ?, status = 'ended', end_reason = ?
           WHERE id = ?`,
        )
          .bind(Date.now(), durationS, `tata:${reason}`.slice(0, 64), `tata-${state.streamSid}`.slice(0, 64))
          .run()
          .catch(() => {});
        try { server.close(1000, 'stop'); } catch { /* already closed */ }
        break;
      }
    }
  });

  server.addEventListener('close', () => {
    hangup = true;
    if (state.streamSid && state.startedAt > 0) {
      const durationS = Math.round((Date.now() - state.startedAt) / 1000);
      env.DB.prepare(
        `UPDATE calls SET ended_at = ?, duration_s = ?, status = 'ended', end_reason = COALESCE(end_reason, 'ws_close')
         WHERE id = ?`,
      )
        .bind(Date.now(), durationS, `tata-${state.streamSid}`.slice(0, 64))
        .run()
        .catch(() => {});
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}
