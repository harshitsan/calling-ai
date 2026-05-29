import { Phone, PhoneOff, Send } from 'lucide-react';
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

const VAD_FLOOR = 0.045; // ignore anything quieter than this (ambient)
const VAD_RATIO = 2.2; // user speech must exceed the adaptive baseline by this factor
const VAD_FRAMES = 3; // consecutive frames to confirm a barge-in
const SPEAK_GRACE = 0.15; // seconds of grace after scheduled audio ends

export function TestCall() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [customer, setCustomer] = useState('Alex');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [text, setText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveRef = useRef(false);
  const recRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const vadRaf = useRef<number | null>(null);

  useEffect(() => {
    api<{ agents: Agent[] }>('/api/agents').then((r) => {
      setAgents(r.agents);
      if (r.agents[0]) setAgentId(r.agents[0].id);
    });
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureCtx() {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
    return ctxRef.current;
  }

  // Self-healing "agent is speaking" check derived from the audio clock — no flag to get stuck.
  function isSpeaking() {
    const c = ctxRef.current;
    return !!c && c.currentTime < nextStartRef.current - 0.001 + SPEAK_GRACE && nextStartRef.current > 0;
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
    sourcesRef.current.push(src);
    src.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== src);
    };
  }

  function stopAudio() {
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    sourcesRef.current = [];
    nextStartRef.current = ctxRef.current ? ctxRef.current.currentTime : 0; // -> isSpeaking() false
  }

  function bargeIn() {
    stopAudio();
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
  }

  async function startVad() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micStreamRef.current = stream;
      const ctx = await ensureCtx();
      const srcNode = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      srcNode.connect(analyser);
      // Force the graph to pull audio: analyser -> muted gain -> destination.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(ctx.destination);

      const data = new Uint8Array(analyser.fftSize);
      let consec = 0;
      let baseline = 0.01;
      const loop = () => {
        if (!liveRef.current) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / data.length);
        if (isSpeaking()) {
          if (rms > VAD_FLOOR && rms > baseline * VAD_RATIO) {
            if (++consec >= VAD_FRAMES) {
              consec = 0;
              bargeIn();
            }
          } else {
            consec = 0;
            baseline = baseline * 0.95 + rms * 0.05;
          }
        } else {
          consec = 0;
          baseline = baseline * 0.9 + rms * 0.1;
        }
        vadRaf.current = requestAnimationFrame(loop);
      };
      vadRaf.current = requestAnimationFrame(loop);
    } catch {
      // mic denied: barge-in disabled, text still works
    }
  }

  // Robust continuous recognition: spawn a FRESH instance on every end (Chrome
  // dies on timeouts/errors; reusing an instance gets stuck).
  function startRecognition() {
    const SR = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    const Rec = SR.SpeechRecognition || SR.webkitSpeechRecognition;
    if (!Rec) return;

    const spawn = () => {
      if (!liveRef.current) return;
      const rec = new Rec();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e: any) => {
        const r = e.results[e.results.length - 1];
        if (!r.isFinal) return;
        if (isSpeaking()) return; // half-duplex: ignore echo while agent talks
        send(r[0].transcript);
      };
      rec.onerror = () => {
        /* onend handles the respawn */
      };
      rec.onend = () => {
        if (liveRef.current) setTimeout(spawn, 300);
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        if (liveRef.current) setTimeout(spawn, 500);
      }
    };
    spawn();
  }

  async function start() {
    if (!agentId) return;
    setStatus('connecting');
    setLines([]);
    setLatency(null);
    await ensureCtx();
    liveRef.current = true;
    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/call?agentId=${agentId}&token=${encodeURIComponent(token ?? '')}&customer_name=${encodeURIComponent(customer)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      setStatus('live');
      startVad();
      startRecognition();
    };
    ws.onclose = () => {
      if (liveRef.current) stop();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        playAudio(e.data as ArrayBuffer);
        return;
      }
      const ev = JSON.parse(e.data);
      if (ev.type === 'transcript') setLines((l) => [...l, { role: ev.role, text: ev.text }]);
      else if (ev.type === 'flush') stopAudio();
      else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) setLatency(ev.turn.endpointToFirstAudio);
    };
    wsRef.current = ws;
  }

  function stop() {
    liveRef.current = false;
    if (vadRaf.current) cancelAnimationFrame(vadRaf.current);
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    stopAudio();
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'hangup' }));
    wsRef.current?.close();
    wsRef.current = null;
    setStatus('idle');
  }

  function send(t: string) {
    if (!t.trim() || wsRef.current?.readyState !== 1) return;
    stopAudio(); // talking/typing interrupts the agent
    wsRef.current.send(JSON.stringify({ type: 'userText', text: t }));
    setText('');
  }

  const live = status === 'live' || status === 'connecting';

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
            <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-56" disabled={live}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Caller name</Label>
            <Input value={customer} onChange={(e) => setCustomer(e.target.value)} className="w-40" disabled={live} />
          </div>
          {status === 'idle' ? (
            <Button onClick={start} disabled={!agentId}>
              <Phone className="h-4 w-4" /> Start call
            </Button>
          ) : (
            <Button variant="destructive" onClick={stop}>
              <PhoneOff className="h-4 w-4" />
              {status === 'connecting' ? 'Connecting…' : 'Stop'}
            </Button>
          )}
          {status === 'live' && (
            <span className="flex items-center gap-2 text-sm text-emerald-600">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" /> Live — just talk
            </span>
          )}
          {latency != null && <span className="text-sm text-muted-foreground">first audio: {latency}ms</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 min-h-[200px]">
          {lines.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Start the call, then just speak — the agent listens continuously and you can talk over it to interrupt.
            </p>
          )}
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
          placeholder="Or type a message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(text)}
          disabled={status !== 'live'}
        />
        <Button onClick={() => send(text)} disabled={status !== 'live'}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
