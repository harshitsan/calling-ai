import { handleApi } from './api';
import { verifyJwt } from './auth';
import { CallSession } from './call-session';
import { LogHub } from './log-hub';
import { MemoryStore } from './memory-store';

export { CallSession, LogHub, MemoryStore };

const LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-api-key',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me' ||
        url.pathname.startsWith('/api/agents') || url.pathname.startsWith('/api/calls') ||
        url.pathname === '/api/usage') {
      const res = await handleApi(request, env);
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
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
      const r = (await env.AI.run(LLM_MODEL as never, {
        messages: [{ role: 'user', content: text }],
        max_tokens: 256,
      } as never)) as { response?: string };
      return Response.json({ reply: r.response ?? '' });
    }

    if (url.pathname === '/api/tts') {
      const text = url.searchParams.get('text') ?? 'Hello from Cloudflare.';
      const speaker = url.searchParams.get('voice') ?? 'asteria';
      const res = (await env.AI.run('@cf/deepgram/aura-1' as never, {
        text,
        speaker,
        encoding: 'mp3',
      } as never)) as unknown;
      const audio = res instanceof ReadableStream ? res : new Response(res as BodyInit).body;
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    }

    if (url.pathname === '/demo') {
      return new Response(DEMO_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Everything else: serve the React dashboard (SPA fallback handled by assets config).
    return env.ASSETS.fetch(request);
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
