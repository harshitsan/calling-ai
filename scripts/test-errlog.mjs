import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `err+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Err' }),
  })
).json();
const token = reg.token;

const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Tooler',
      voice: 'asteria',
      systemPromptTemplate:
        'You are {{agent_name}}. As soon as the caller says anything, call the check_status tool to look it up, then answer.',
      variables: [],
      tools: [
        {
          name: 'check_status',
          description: 'Check system status. Call this whenever the caller asks anything.',
          parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
          webhookUrl: 'https://this-host-does-not-exist-9xz.invalid/status',
        },
      ],
      endpointingMs: 800,
    }),
  })
).json();
const agentId = create.agent.id;

const logs = new WebSocket(`${BASE.replace('https', 'wss')}/logs?token=${encodeURIComponent(token)}`);
logs.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'log' && (m.event.level === 'error' || m.event.level === 'warn')) {
    console.log('ISSUE', m.event.level, m.event.service, m.event.msg, JSON.stringify(m.event.data ?? {}));
  }
});
await new Promise((res) => logs.on('open', res));
await sleep(300);

const call = new WebSocket(`${BASE.replace('https', 'wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Lee`);
call.on('open', () => call.send(JSON.stringify({ type: 'userText', text: 'what is the status of my order' })));
await sleep(8000);
try { call.close(); } catch {}
await sleep(1000);
process.exit(0);
