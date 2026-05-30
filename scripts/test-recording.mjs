// Verifies the recording round trip: create a fake call via WS, upload a small
// webm-like blob, then fetch it back from R2 via the API.
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `rec+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Rec' }),
})).json();
const token = reg.token;
const create = await (await fetch(`${BASE}/api/agents`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ name: 'Rec', voice: 'asteria', systemPromptTemplate: 'Be brief.', variables: [], tools: [] }),
})).json();
const agentId = create.agent.id;

// Open a call, capture callId via 'meta'
const ws = new WebSocket(`${BASE.replace('https','wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Avery`);
let callId = null;
ws.on('message', (d, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(d.toString());
  if (ev.type === 'meta') callId = ev.callId;
});
await new Promise((res) => ws.on('open', res));
ws.send(JSON.stringify({ type: 'userText', text: 'hi' }));
await sleep(5000);
ws.send(JSON.stringify({ type: 'hangup' }));
await sleep(3000);
try { ws.close(); } catch {}
console.log('callId:', callId);

// Upload a dummy "recording" blob (webm magic header bytes)
const fake = Buffer.from([0x1a,0x45,0xdf,0xa3, 0xde,0xad,0xbe,0xef, 0xca,0xfe,0xba,0xbe, 0x10,0x20,0x30,0x40, 0x50,0x60,0x70,0x80]);
const up = await fetch(`${BASE}/api/calls/${callId}/recording`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/webm' },
  body: fake,
});
console.log('upload:', up.status, await up.text());

// Fetch it back
const dl = await fetch(`${BASE}/api/calls/${callId}/recording`, {
  headers: { authorization: `Bearer ${token}` },
});
const bytes = new Uint8Array(await dl.arrayBuffer());
console.log('download:', dl.status, 'bytes:', bytes.length, 'magic:', Array.from(bytes.slice(0,4)).map((b) => b.toString(16).padStart(2,'0')).join(''));

// Verify the call detail now reports a recording_key
const detail = await (await fetch(`${BASE}/api/calls/${callId}`, { headers: { authorization: `Bearer ${token}` } })).json();
console.log('detail.recording_key:', detail.call.recording_key);

// Voice preview path (unauth)
const tts = await fetch(`${BASE}/api/tts?voice=luna&text=Hi%20there`);
console.log('preview tts:', tts.status, tts.headers.get('content-type'));
process.exit(0);
