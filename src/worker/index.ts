import { handleApi, authenticate } from './api';
import { openaiComplete, synthesizeTtsCached } from './adapters';
import { verifyJwt } from './auth';
import { CallSession } from './call-session';
import { LogHub } from './log-hub';
import { MemoryStore } from './memory-store';
import { VOICEOVERS_ENABLED, handleVoiceoverApi } from './voiceovers';
import { VOICE_INTEGRATIONS_ENABLED, handleVoiceIntegrationsApi } from './voice-integrations';
import { handleTataStream } from './voice-stream-tata';
import { handleTwilioVoice, handleTwilioStatus } from './twilio';
import { NOTETAKER_ENABLED, handleNotetakerApi, handleNotetakerQueue } from './notetaker';
import type { NotetakerQueueMessage } from './notetaker';
import { handleApiKeysApi } from './api-keys';
import { handleMeetingDispatchApi } from './meeting-dispatch';
import { RecorderContainer } from './recorder-container';

export { CallSession, LogHub, MemoryStore, RecorderContainer };

const LLM_MODEL = 'gpt-4o-mini';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-api-key',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    // Bot Google session for the recorder container's boot (see
    // recorder-container.ts). Gated on the same secret that authenticates
    // worker→recorder calls.
    if (url.pathname === '/internal/recorder/storage-state' && request.method === 'GET') {
      const secret = (env as unknown as { RECORDER_CONTROL_SECRET?: string }).RECORDER_CONTROL_SECRET;
      if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const obj = await env.RECORDINGS.get('internal/bot-storage-state.json');
      if (!obj) return new Response('storage state not uploaded', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me' ||
        url.pathname.startsWith('/api/agents') || url.pathname.startsWith('/api/calls') ||
        url.pathname === '/api/usage') {
      const res = await handleApi(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }

    // Voice Integrations (isolated module — flip VOICE_INTEGRATIONS_ENABLED in
    // src/worker/voice-integrations.ts to disable).
    if (VOICE_INTEGRATIONS_ENABLED && url.pathname.startsWith('/api/voice-integrations')) {
      const auth = await authenticate(request, env);
      const res = await handleVoiceIntegrationsApi(request, env, auth);
      if (res) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    }

    // API key self-service. Session (JWT) auth ONLY — deliberately not
    // authenticate(), so an api key can never mint or revoke keys.
    if (url.pathname.startsWith('/api/api-keys')) {
      const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
      const authz = request.headers.get('authorization');
      let sessionAuth: { tenantId: string; userId: string } | null = null;
      if (authz?.startsWith('Bearer ')) {
        const claims = await verifyJwt(authz.slice(7), secret);
        if (claims) sessionAuth = { tenantId: claims.tid, userId: claims.sub };
      }
      const res = await handleApiKeysApi(request, env, sessionAuth);
      if (res) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    }

    // Meeting dispatch — must run before the notetaker handler so
    // /api/notetaker/meetings* isn't swallowed by its catch-all 404.
    if (NOTETAKER_ENABLED && url.pathname.startsWith('/api/notetaker/meetings')) {
      const auth = await authenticate(request, env);
      const res = await handleMeetingDispatchApi(request, env, auth);
      if (res) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    }

    // Notetaker (isolated module — flip NOTETAKER_ENABLED in src/worker/notetaker.ts to disable).
    // /api/v1/notetaker is the public versioned alias for external orgs.
    if (NOTETAKER_ENABLED &&
        (url.pathname.startsWith('/api/notetaker') || url.pathname.startsWith('/api/v1/notetaker'))) {
      const auth = await authenticate(request, env);
      let resolvedAuth = auth;
      // <audio src> can't send headers — accept `?_t=<jwt>` on audio sub-path.
      if (!resolvedAuth && /^\/api\/notetaker\/[a-f0-9-]+\/audio$/.test(url.pathname) && request.method === 'GET') {
        const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
        const claims = await verifyJwt(url.searchParams.get('_t') ?? '', secret);
        if (claims) resolvedAuth = { tenantId: claims.tid, userId: claims.sub };
      }
      const res = await handleNotetakerApi(request, env, ctx, resolvedAuth);
      if (res) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    }

    // Voiceovers (isolated module — flip VOICEOVERS_ENABLED in src/worker/voiceovers.ts to disable).
    if (VOICEOVERS_ENABLED && url.pathname.startsWith('/api/voiceovers')) {
      let auth = await authenticate(request, env);
      // <audio src=...> can't send headers — accept `?token=<jwt>` on the audio sub-path only.
      if (!auth && /^\/api\/voiceovers\/[a-f0-9-]+\/audio$/.test(url.pathname) && request.method === 'GET') {
        const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
        const claims = await verifyJwt(url.searchParams.get('_t') ?? '', secret);
        if (claims) auth = { tenantId: claims.tid, userId: claims.sub };
      }
      const res = await handleVoiceoverApi(request, env, auth);
      if (res) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    }

    // Twilio inbound Voice webhook (also the entry point for SIP calls via a
    // Twilio Elastic SIP Trunk). Returns TwiML that streams the call to
    // /voice/stream. No CORS — Twilio is a server-to-server caller.
    if (VOICE_INTEGRATIONS_ENABLED && url.pathname === '/twilio/voice') {
      return handleTwilioVoice(request, env);
    }

    // Twilio outbound call-status callbacks (ringing/answered/completed).
    if (VOICE_INTEGRATIONS_ENABLED && url.pathname === '/twilio/status') {
      return handleTwilioStatus(request, env);
    }

    // Carrier streaming endpoint — Twilio Media Streams format (also spoken
    // by Tata, Acefone, and others). The /voice/stream/tata alias keeps any
    // pre-existing carrier-side config working.
    if (VOICE_INTEGRATIONS_ENABLED &&
        (url.pathname === '/voice/stream' || url.pathname === '/voice/stream/tata')) {
      return handleTataStream(request, env);
    }

    if (url.pathname === '/call') {
      const id = env.CALL_SESSION.newUniqueId();
      const stub = env.CALL_SESSION.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/logs') {
      const secret = (env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
      const claims = await verifyJwt(url.searchParams.get('token') ?? '', secret);
      if (!claims) return new Response('unauthorized', { status: 401 });
      const stub = env.LOGS.get(env.LOGS.idFromName(claims.tid));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { text?: string };
      const text = body.text ?? 'Say hello in one short sentence.';
      const openaiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
      if (!openaiKey) return Response.json({ error: 'OPENAI_API_KEY not configured' }, { status: 503 });
      const reply = await openaiComplete(openaiKey, [{ role: 'user', content: text }], { model: LLM_MODEL });
      return Response.json({ reply });
    }

    if (url.pathname === '/api/tts') {
      const text = url.searchParams.get('text') ?? 'Hello from Cloudflare.';
      const voiceId = url.searchParams.get('voice') ?? 'asteria';
      try {
        const { bytes, contentType, cached } = await synthesizeTtsCached({
          ai: env.AI,
          googleApiKey: (env as unknown as { GOOGLE_AI_API_KEY?: string }).GOOGLE_AI_API_KEY,
          voiceId,
          text,
          kv: env.TTS_CACHE,
        });
        return new Response(bytes, {
          headers: {
            'content-type': contentType,
            'x-tts-cache': cached ? 'HIT' : 'MISS',
            'cache-control': 'public, max-age=86400',
          },
        });
      } catch (e) {
        return new Response(`tts error: ${(e as Error).message}`, { status: 500 });
      }
    }

    if (url.pathname === '/demo') {
      return new Response(DEMO_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Everything else: serve the React dashboard (SPA fallback handled by assets config).
    return env.ASSETS.fetch(request);
  },

  // Notetaker async pipeline — see queues config in wrangler.jsonc.
  async queue(batch: MessageBatch<NotetakerQueueMessage>, env: Env): Promise<void> {
    await handleNotetakerQueue(batch as unknown as Parameters<typeof handleNotetakerQueue>[0], env);
  },
};

const DEMO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>calling-ai demo</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #111; }
  h1 { font-size: 1.25rem; }
  #log { border: 1px solid #ddd; border-radius: 8px; padding: .75rem; height: 300px; overflow-y: auto; background: #fafafa; }
  .msg { margin: .35rem 0; }
  .user { color: #1a56db; }
  .assistant { color: #047857; }
  .meta { color: #6b7280; font-size: .8rem; }
  .row { display: flex; gap: .5rem; margin-top: .75rem; align-items: center; }
  input[type=text] { flex: 1; padding: .5rem; border: 1px solid #ccc; border-radius: 6px; }
  select { padding: .5rem; border: 1px solid #ccc; border-radius: 6px; }
  button { padding: .5rem .9rem; border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  button.secondary { background: #6b7280; }
  label { font-size: .85rem; color: #374151; }
  #status { font-size: .85rem; color: #6b7280; }
</style>
</head>
<body>
  <h1>calling-ai &mdash; voice agent demo</h1>
  <div class="row">
    <label for="voice">Voice</label>
    <select id="voice">
      <optgroup label="Female">
        <option value="asteria">Asteria</option>
        <option value="luna">Luna</option>
        <option value="stella">Stella</option>
        <option value="athena">Athena</option>
        <option value="hera">Hera</option>
      </optgroup>
      <optgroup label="Male">
        <option value="orion">Orion</option>
        <option value="arcas">Arcas</option>
        <option value="perseus">Perseus</option>
        <option value="angus">Angus</option>
        <option value="orpheus">Orpheus</option>
        <option value="helios">Helios</option>
        <option value="zeus">Zeus</option>
      </optgroup>
    </select>
    <span id="status">connecting&hellip;</span>
  </div>
  <div id="log"></div>
  <div class="row">
    <input id="text" type="text" placeholder="Type a message and press Send" autocomplete="off" />
    <button id="send">Send</button>
  </div>
  <div class="row">
    <button id="mic" class="secondary">🎤 Talk</button>
    <button id="interrupt" class="secondary">Interrupt</button>
    <button id="hangup" class="secondary">Hang up</button>
  </div>
  <p class="meta">LLM: Llama 3.1 8B (Workers AI) &middot; Voice: Deepgram Aura &middot; STT here uses the browser (production = Deepgram Flux).</p>
<script>
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const voiceEl = document.getElementById('voice');
const textEl = document.getElementById('text');

function add(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + (cls || '');
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- gapless Web Audio playback ----
let audioCtx = null;
let nextStart = 0;
let sources = [];
async function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
}
async function enqueueAudio(arrayBuffer) {
  await ensureCtx();
  let buf;
  try { buf = await audioCtx.decodeAudioData(arrayBuffer.slice(0)); } catch (e) { return; }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  const start = Math.max(audioCtx.currentTime + 0.02, nextStart);
  src.start(start);
  nextStart = start + buf.duration;
  sources.push(src);
  src.onended = () => { sources = sources.filter((s) => s !== src); };
}
function stopAudio() {
  for (const s of sources) { try { s.stop(); } catch (e) {} }
  sources = [];
  nextStart = audioCtx ? audioCtx.currentTime : 0;
}

// ---- websocket call ----
let ws = null;
function connect(voice) {
  if (ws) { try { ws.close(); } catch (e) {} }
  stopAudio();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/call?voice=' + encodeURIComponent(voice));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { statusEl.textContent = 'connected (' + voice + ')'; };
  ws.onclose = () => { statusEl.textContent = 'disconnected'; };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { enqueueAudio(e.data); return; }
    const ev = JSON.parse(e.data);
    if (ev.type === 'transcript') add((ev.role === 'user' ? 'You: ' : 'Agent: ') + ev.text, ev.role);
    else if (ev.type === 'state') statusEl.textContent = ev.state;
    else if (ev.type === 'flush') stopAudio();
    else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) add('↳ first audio ' + ev.turn.endpointToFirstAudio + 'ms', 'meta');
    else if (ev.type === 'ended') { add('— call ended (' + ev.reason + ') —', 'meta'); statusEl.textContent = 'ended'; }
  };
}

function sendText(text) {
  if (!text.trim() || !ws || ws.readyState !== 1) return;
  ensureCtx();
  ws.send(JSON.stringify({ type: 'userText', text }));
}

connect(voiceEl.value);
voiceEl.onchange = () => connect(voiceEl.value);

document.getElementById('send').onclick = () => { sendText(textEl.value); textEl.value = ''; };
textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendText(textEl.value); textEl.value = ''; } });
document.getElementById('interrupt').onclick = () => { stopAudio(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'interrupt' })); };
document.getElementById('hangup').onclick = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup' })); };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = document.getElementById('mic');
if (SR) {
  const rec = new SR();
  rec.continuous = false; rec.interimResults = false; rec.lang = 'en-US';
  let on = false;
  rec.onresult = (e) => { sendText(e.results[0][0].transcript); };
  rec.onend = () => { on = false; micBtn.textContent = '🎤 Talk'; };
  micBtn.onclick = async () => {
    await ensureCtx();
    if (on) { rec.stop(); } else { on = true; micBtn.textContent = '◉ Listening…'; rec.start(); }
  };
} else {
  micBtn.disabled = true; micBtn.textContent = 'mic n/a';
}
</script>
</body>
</html>`;
