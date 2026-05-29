import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const email = `dev+${Date.now()}@gomagentic.com`;

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'supersecret1', tenantName: 'WS Test' }),
  })
).json();
const token = reg.token;

const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Greeter',
      voice: 'stella',
      role: 'greeter',
      systemPromptTemplate:
        'You are {{agent_name}} greeting {{customer_name}}. Greet them by name in one short sentence.',
      variables: [{ name: 'customer_name', source: 'call_init' }],
      tools: [],
    }),
  })
).json();
const agentId = create.agent.id;
console.log('agentId', agentId, 'voice', create.agent.voice);

const wsUrl =
  `${BASE.replace('https', 'wss')}/call?agentId=${agentId}` +
  `&token=${encodeURIComponent(token)}&customer_name=Bob`;
const ws = new WebSocket(wsUrl);
let audioBytes = 0;

ws.on('open', () => ws.send(JSON.stringify({ type: 'userText', text: 'hi' })));
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    audioBytes += data.length;
    return;
  }
  console.log('EVT', data.toString());
});
ws.on('error', (e) => console.error('WS ERROR', e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setTimeout(async () => {
  console.log('audioBytes', audioBytes);
  ws.send(JSON.stringify({ type: 'hangup' }));
  await sleep(4000); // let finalize() run (summary + persist)
  ws.close();

  const calls = await (
    await fetch(`${BASE}/api/calls`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  console.log('CALLS', JSON.stringify(calls, null, 2));
  if (calls.calls?.[0]) {
    const detail = await (
      await fetch(`${BASE}/api/calls/${calls.calls[0].id}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    console.log('DETAIL', JSON.stringify(detail, null, 2));
  }
  process.exit(0);
}, 7000);
