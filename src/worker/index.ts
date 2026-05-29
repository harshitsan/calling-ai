import { CallSession } from './call-session';

export { CallSession };

const LLM_MODEL = '@cf/meta/llama-3.1-8b-instruct';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/call') {
      const id = env.CALL_SESSION.newUniqueId();
      const stub = env.CALL_SESSION.get(id);
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
      const speaker = url.searchParams.get('voice') ?? 'angus';
      const res = (await env.AI.run('@cf/deepgram/aura-1' as never, {
        text,
        speaker,
        encoding: 'mp3',
      } as never)) as unknown;
      const audio = res instanceof ReadableStream ? res : new Response(res as BodyInit).body;
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    }

    if (url.pathname === '/') {
      return new Response(DEMO_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
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
  #log { border: 1px solid #ddd; border-radius: 8px; padding: .75rem; height: 320px; overflow-y: auto; background: #fafafa; }
  .msg { margin: .35rem 0; }
  .user { color: #1a56db; }
  .assistant { color: #047857; }
  .meta { color: #6b7280; font-size: .8rem; }
  .row { display: flex; gap: .5rem; margin-top: .75rem; }
  input[type=text] { flex: 1; padding: .5rem; border: 1px solid #ccc; border-radius: 6px; }
  button { padding: .5rem .9rem; border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
  button.secondary { background: #6b7280; }
  #status { font-size: .85rem; color: #6b7280; }
</style>
</head>
<body>
  <h1>calling-ai &mdash; voice agent demo</h1>
  <p id="status">connecting&hellip;</p>
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
const audioQueue = [];
let playing = false;

function add(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + (cls || '');
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

async function playNext() {
  if (playing || audioQueue.length === 0) return;
  playing = true;
  const buf = audioQueue.shift();
  const blob = new Blob([buf], { type: 'audio/mpeg' });
  const audio = new Audio(URL.createObjectURL(blob));
  audio.onended = () => { playing = false; playNext(); };
  audio.onerror = () => { playing = false; playNext(); };
  try { await audio.play(); } catch { playing = false; playNext(); }
}

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(proto + '://' + location.host + '/call');
ws.binaryType = 'arraybuffer';
ws.onopen = () => { statusEl.textContent = 'connected'; };
ws.onclose = () => { statusEl.textContent = 'disconnected'; };
ws.onmessage = (e) => {
  if (typeof e.data !== 'string') { audioQueue.push(e.data); playNext(); return; }
  const ev = JSON.parse(e.data);
  if (ev.type === 'transcript') add((ev.role === 'user' ? 'You: ' : 'Agent: ') + ev.text, ev.role);
  else if (ev.type === 'state') statusEl.textContent = ev.state;
  else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) add('↳ first audio ' + ev.turn.endpointToFirstAudio + 'ms', 'meta');
  else if (ev.type === 'ended') { add('— call ended (' + ev.reason + ') —', 'meta'); statusEl.textContent = 'ended'; }
};

function sendText(text) {
  if (!text.trim() || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'userText', text }));
}

const textEl = document.getElementById('text');
document.getElementById('send').onclick = () => { sendText(textEl.value); textEl.value = ''; };
textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendText(textEl.value); textEl.value = ''; } });
document.getElementById('interrupt').onclick = () => ws.send(JSON.stringify({ type: 'interrupt' }));
document.getElementById('hangup').onclick = () => ws.send(JSON.stringify({ type: 'hangup' }));

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = document.getElementById('mic');
if (SR) {
  const rec = new SR();
  rec.continuous = false; rec.interimResults = false; rec.lang = 'en-US';
  let on = false;
  rec.onresult = (e) => { const t = e.results[0][0].transcript; sendText(t); };
  rec.onend = () => { on = false; micBtn.textContent = '🎤 Talk'; };
  micBtn.onclick = () => { if (on) { rec.stop(); } else { on = true; micBtn.textContent = '◉ Listening…'; rec.start(); } };
} else {
  micBtn.disabled = true; micBtn.textContent = 'mic n/a';
}
</script>
</body>
</html>`;
