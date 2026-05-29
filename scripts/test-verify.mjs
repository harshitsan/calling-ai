import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `v+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Verify' }),
  })
).json();
const token = reg.token;

const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Ender',
      voice: 'asteria',
      systemPromptTemplate: 'You are {{agent_name}}. Be brief. If the caller says goodbye or asks to end, call the end_call tool.',
      variables: [],
      tools: [],
      endpointingMs: 1500,
    }),
  })
).json();
const agentId = create.agent.id;
console.log('endpointingMs persisted:', create.agent.endpointingMs);

// end_call via tool
const call = new WebSocket(`${BASE.replace('https', 'wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Pat`);
let endedReason = null;
call.on('open', () => call.send(JSON.stringify({ type: 'userText', text: 'That is all I needed, thank you. Please end the call now.' })));
call.on('message', (d, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(d.toString());
  if (ev.type === 'transcript' && ev.role === 'assistant') console.log('agent:', ev.text);
  if (ev.type === 'ended') endedReason = ev.reason;
});
await sleep(7000);
console.log('ended reason:', endedReason);
try { call.close(); } catch {}
await sleep(2500);

// logs persistence: fresh connection should replay history from DB
const logs = new WebSocket(`${BASE.replace('https', 'wss')}/logs?token=${encodeURIComponent(token)}`);
let historyCount = -1;
logs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'history') historyCount = m.events.length;
});
await new Promise((res) => logs.on('open', res));
await sleep(800);
console.log('persisted log history events:', historyCount);
process.exit(0);
