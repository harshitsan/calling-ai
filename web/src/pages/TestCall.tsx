import { Mic, PhoneOff, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api, getToken } from '@/lib/api';

interface Agent {
  id: string;
  name: string;
}
interface Line {
  role: string;
  text: string;
}

export function TestCall() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [customer, setCustomer] = useState('Alex');
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [text, setText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);

  useEffect(() => {
    api<{ agents: Agent[] }>('/api/agents').then((r) => {
      setAgents(r.agents);
      if (r.agents[0]) setAgentId(r.agents[0].id);
    });
    return () => wsRef.current?.close();
  }, []);

  async function ensureCtx() {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
    return ctxRef.current;
  }

  async function playAudio(buf: ArrayBuffer) {
    const ctx = await ensureCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(buf.slice(0));
    } catch {
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    const start = Math.max(ctx.currentTime + 0.02, nextStartRef.current);
    src.start(start);
    nextStartRef.current = start + decoded.duration;
  }

  function connect() {
    if (!agentId) return;
    ensureCtx();
    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/call?agentId=${agentId}&token=${encodeURIComponent(token ?? '')}&customer_name=${encodeURIComponent(customer)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        playAudio(e.data as ArrayBuffer);
        return;
      }
      const ev = JSON.parse(e.data);
      if (ev.type === 'transcript') setLines((l) => [...l, { role: ev.role, text: ev.text }]);
      else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) setLatency(ev.turn.endpointToFirstAudio);
    };
    wsRef.current = ws;
    setLines([]);
  }

  function hangup() {
    wsRef.current?.send(JSON.stringify({ type: 'hangup' }));
    wsRef.current?.close();
    setConnected(false);
  }

  function send(t: string) {
    if (!t.trim() || wsRef.current?.readyState !== 1) return;
    wsRef.current.send(JSON.stringify({ type: 'userText', text: t }));
    setText('');
  }

  function startMic() {
    const SR = (window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any });
    const Rec = SR.SpeechRecognition || SR.webkitSpeechRecognition;
    if (!Rec) return alert('SpeechRecognition not supported in this browser.');
    const rec = new Rec();
    rec.lang = 'en-US';
    rec.onresult = (e: any) => send(e.results[0][0].transcript);
    rec.start();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Test Call</h1>

      <Card>
        <CardHeader>
          <CardTitle>Setup</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 items-end">
          <div className="space-y-1">
            <Label>Agent</Label>
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-56" disabled={connected}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Caller name</Label>
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} className="w-40" disabled={connected} />
          </div>
          {connected ? (
            <Button variant="destructive" onClick={hangup}>
              <PhoneOff className="h-4 w-4" /> Hang up
            </Button>
          ) : (
            <Button onClick={connect} disabled={!agentId}>
              Start call
            </Button>
          )}
          {latency != null && <span className="text-sm text-muted-foreground">first audio: {latency}ms</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 min-h-[200px]">
          {lines.length === 0 && <p className="text-sm text-muted-foreground">Start a call, then talk or type.</p>}
          {lines.map((l, i) => (
            <div key={i} className="text-sm">
              <span className={l.role === 'user' ? 'text-blue-600 font-medium' : 'text-emerald-700 font-medium'}>
                {l.role === 'user' ? 'You' : 'Agent'}:
              </span>{' '}
              {l.text}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Input
          placeholder="Type a message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(text)}
          disabled={!connected}
        />
        <Button onClick={() => send(text)} disabled={!connected}>
          <Send className="h-4 w-4" />
        </Button>
        <Button variant="secondary" onClick={startMic} disabled={!connected}>
          <Mic className="h-4 w-4" /> Talk
        </Button>
      </div>
    </div>
  );
}
