import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reg = await (
  await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `mem+${Date.now()}@gomagentic.com`, password: 'supersecret1', tenantName: 'Mem Test' }),
  })
).json();
const token = reg.token;

const create = await (
  await fetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Memo',
      voice: 'asteria',
      systemPromptTemplate: 'You are {{agent_name}} talking to {{customer_name}}. Be brief.',
      variables: [{ name: 'customer_name', source: 'call_init' }],
      tools: [],
    }),
  })
).json();
const agentId = create.agent.id;

function runCall(userText, label) {
  return new Promise((resolve) => {
    const wsUrl = `${BASE.replace('https', 'wss')}/call?agentId=${agentId}&token=${encodeURIComponent(token)}&customer_name=Dana`;
    const ws = new WebSocket(wsUrl);
    let lastAssistant = '';
    ws.on('open', () => ws.send(JSON.stringify({ type: 'userText', text: userText })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const ev = JSON.parse(data.toString());
      if (ev.type === 'transcript' && ev.role === 'assistant') lastAssistant = ev.text;
    });
    setTimeout(() => {
      console.log(`[${label}] user:`, userText);
      console.log(`[${label}] agent:`, lastAssistant);
      ws.send(JSON.stringify({ type: 'hangup' }));
      setTimeout(() => { ws.close(); resolve(); }, 4500); // allow extraction
    }, 6000);
  });
}

console.log('--- Call 1: state a fact ---');
await runCall('Please remember that my favorite color is teal and I drive a Tesla.', 'call1');
await sleep(3000);
console.log('--- Call 2: ask about it (memory should recall) ---');
await runCall('What is my favorite color and what do I drive?', 'call2');
process.exit(0);
