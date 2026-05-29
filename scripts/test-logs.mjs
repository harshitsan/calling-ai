import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `logs+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Logs Test' }),
  })
).json();
const token = reg.token;
const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Logger', voice: 'asteria', systemPromptTemplate: 'You are {{agent_name}}. Be brief.', variables: [], tools: [] }),
  })
).json();
const agentId = create.agent.id;

// subscribe to logs first
const logs = new WebSocket(`${BASE.replace('https', 'wss')}/logs?token=${encodeURIComponent(token)}`);
logs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'log') console.log('LOG', m.event.service.padEnd(7), m.event.msg, JSON.stringify(m.event.data ?? {}));
});
await new Promise((res) => logs.on('open', res));
await sleep(300);

// run a call
const call = new WebSocket(`${BASE.replace('https', 'wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Sam`);
call.on('open', () => call.send(JSON.stringify({ type: 'userText', text: 'hello there' })));
await sleep(6000);
call.send(JSON.stringify({ type: 'hangup' }));
await sleep(4000);
process.exit(0);
