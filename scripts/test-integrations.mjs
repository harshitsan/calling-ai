import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `int+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Int' }),
  })
).json();
const token = reg.token;

const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Greeter',
      voice: 'asteria',
      systemPromptTemplate: "You are {{agent_name}}. The caller's name is {{name}} from {{company}}. Greet them by first name in one short sentence.",
      variables: [
        { name: 'name', source: 'webhook' },
        { name: 'company', source: 'webhook' },
      ],
      tools: [],
      endpointingMs: 800,
      inboundLookup: { url: 'https://jsonplaceholder.typicode.com/users/1', method: 'GET', headers: {}, timeoutMs: 5000 },
      endWebhook: { url: 'https://httpbin.org/anything', headers: { 'x-source': 'calling-ai' } },
    }),
  })
).json();
const agentId = create.agent.id;
console.log('agent saved with inboundLookup:', !!create.agent.inboundLookup, 'endWebhook:', !!create.agent.endWebhook);

const logs = new WebSocket(`${BASE.replace('https', 'wss')}/logs?token=${encodeURIComponent(token)}`);
const events = [];
logs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'log') events.push(m.event);
});
await new Promise((res) => logs.on('open', res));
await sleep(300);

const call = new WebSocket(`${BASE.replace('https', 'wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Bret`);
let lastAssistant = '';
call.on('open', () => call.send(JSON.stringify({ type: 'userText', text: 'hi' })));
call.on('message', (d, isBinary) => {
  if (isBinary) return;
  const ev = JSON.parse(d.toString());
  if (ev.type === 'transcript' && ev.role === 'assistant') lastAssistant = ev.text;
});
await sleep(7000);
call.send(JSON.stringify({ type: 'hangup' }));
await sleep(5000);

const inboundOk = events.find((e) => e.service === 'webhook' && e.msg === 'inbound lookup ok');
const endDelivered = events.find((e) => e.service === 'webhook' && e.msg.startsWith('end webhook'));
console.log('inbound lookup keys:', inboundOk?.data?.keys);
console.log('agent response:', lastAssistant);
console.log('end webhook:', endDelivered?.msg, endDelivered?.data);
process.exit(0);
