import { AlertTriangle, Phone, PhoneOff, RotateCw, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api, getToken } from '@/lib/api';

function pickRecorderMime(): string | undefined {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const m of cands) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

interface Agent {
  id: string;
  name: string;
  endpointingMs?: number;
}
interface Line {
  role: string;
  text: string;
  ts: number;
}

function DiagRow({
  label,
  value,
  sub,
  valueClass,
  dot,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  dot?: boolean;
}) {
  const dotColor = valueClass?.includes('emerald')
    ? 'bg-emerald-400/90'
    : valueClass?.includes('amber')
      ? 'bg-amber-400/90'
      : valueClass?.includes('red')
        ? 'bg-red-400/90'
        : 'bg-muted-foreground/60';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/65">{label}</div>
      <div className={`flex items-center gap-2 font-mono text-[13px] tabular-nums ${valueClass ?? 'text-foreground/90'}`}>
        {dot && <span className={`h-2 w-2 rounded-full ${dotColor} ${value === 'open' ? 'animate-pulse' : ''}`} />}
        {value}
      </div>
      {sub && <div className="text-[10px] font-mono text-muted-foreground/55 tabular-nums">{sub}</div>}
    </div>
  );
}

function fmtOffset(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(mm).padStart(3, '0')}`;
}
function latencyColor(ms: number): string {
  if (ms < 800) return 'text-emerald-400';
  if (ms < 1500) return 'text-amber-400';
  return 'text-red-400';
}

const VAD_FLOOR = 0.045;
const VAD_RATIO = 2.2;
const VAD_FRAMES = 3;
const SPEAK_GRACE = 0.15;

function endedLabel(reason: string): string {
  if (reason.startsWith('tool:')) return `— Call ended by the agent (${reason.slice(5)}) —`;
  if (reason === 'client_hangup') return '— Call ended — you hung up —';
  if (reason === 'socket_closed') return '— Call ended — disconnected —';
  return `— Call ended (${reason}) —`;
}

export function TestCall() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState('');
  const [customer, setCustomer] = useState('Alex');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  const [diag, setDiag] = useState({
    engineState: 'idle',
    wsState: 'closed' as 'connecting' | 'open' | 'closing' | 'closed',
    micRms: 0,
    audioQueue: 0,
    recRunning: false,
    recRestarts: 0,
    lastRecResultAt: 0,
    lastEventAt: 0,
    lastError: '',
  });
  const [, force] = useState(0);
  const diagRef = useRef(diag);
  diagRef.current = diag;

  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const liveRef = useRef(false);
  const recRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const vadRaf = useRef<number | null>(null);
  const interimRef = useRef('');
  const baseIndexRef = useRef(0);
  const resultsLenRef = useRef(0);
  const endpointTimer = useRef<number | null>(null);
  const endpointMsRef = useRef(900);
  const lastSent = useRef({ text: '', t: 0 });
  // Recording (mixed mic + agent audio -> R2 on hangup).
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const callIdRef = useRef<string | null>(null);
  const callStartRef = useRef(0);
  // Flux server-side STT via AudioWorklet PCM streaming.
  const captureCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const [sttMode, setSttMode] = useState<'browser' | 'flux'>('browser');
  const sttModeRef = useRef<'browser' | 'flux'>('browser');
  sttModeRef.current = sttMode;

  useEffect(() => {
    api<{ agents: Agent[] }>('/api/agents').then((r) => {
      setAgents(r.agents);
      if (r.agents[0]) setAgentId(r.agents[0].id);
    });
    return () => stop('unmount');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic re-render so "time-ago" labels update.
  useEffect(() => {
    if (status !== 'live') return;
    const id = setInterval(() => force((v) => v + 1), 250);
    return () => clearInterval(id);
  }, [status]);

  // Heartbeat: keep the WebSocket alive during silent stretches so CF / proxies
  // don't idle-close it. Server ignores unrecognized message types.
  useEffect(() => {
    if (status !== 'live') return;
    const id = setInterval(() => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }
    }, 15000);
    return () => clearInterval(id);
  }, [status]);

  // Watchdog: if the recognizer hasn't produced any result in 12s while the
  // mic is clearly hearing speech, force-restart it. Common Chrome failure mode.
  useEffect(() => {
    if (status !== 'live') return;
    const id = setInterval(() => {
      const d = diagRef.current;
      if (!d.recRunning) return;
      if (d.lastRecResultAt === 0) return; // never heard anything yet
      const idleMs = Date.now() - d.lastRecResultAt;
      if (idleMs > 12000 && d.micRms > 0.025) {
        clientLog('recognition stuck — watchdog restart', { idleMs, micRms: d.micRms }, 'warn');
        setDiag((s) => ({ ...s, lastError: 'recognition stuck — auto-restarted' }));
        try {
          recRef.current?.abort();
        } catch {
          /* ignore */
        }
      }
    }, 2000);
    return () => clearInterval(id);
  }, [status]);

  // Stream diagnostic events to the server so they show in Live Logs
  // alongside the stt/tts/llm trail — invaluable for debugging stalls.
  function clientLog(
    msg: string,
    data?: Record<string, unknown>,
    level: 'info' | 'warn' | 'error' = 'info',
  ) {
    if (wsRef.current?.readyState !== 1) return;
    try {
      wsRef.current.send(JSON.stringify({ type: 'client_log', msg, data, level }));
    } catch {
      /* ignore */
    }
  }

  async function startFluxCapture() {
    if (!micStreamRef.current) return;
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      captureCtxRef.current = ctx;
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      const source = ctx.createMediaStreamSource(micStreamRef.current);
      const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
      worklet.port.onmessage = (e) => {
        if (wsRef.current?.readyState === 1) {
          // Binary frame — server routes it to Flux STT via stt.sendAudio
          wsRef.current.send(e.data as ArrayBuffer);
        }
      };
      source.connect(worklet);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      worklet.connect(sink);
      sink.connect(ctx.destination); // keep the graph pulling samples
      workletNodeRef.current = worklet;
      clientLog('flux capture started', { sampleRate: ctx.sampleRate });
    } catch (e) {
      clientLog('flux capture failed', { error: String(e) }, 'error');
    }
  }

  function stopFluxCapture() {
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    workletNodeRef.current = null;
    try { captureCtxRef.current?.close(); } catch { /* ignore */ }
    captureCtxRef.current = null;
  }

  function restartRecognition() {
    clientLog('recognition restart (manual)', undefined, 'warn');
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    setDiag((d) => ({ ...d, lastError: 'manually restarted' }));
  }

  function ago(ts: number): string {
    if (!ts) return '—';
    const ms = Date.now() - ts;
    if (ms < 1000) return `${ms}ms ago`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s ago`;
    return `${Math.floor(ms / 60000)}m ago`;
  }

  function recHealthColor(): string {
    const d = diagRef.current;
    if (!d.recRunning) return 'text-red-400';
    if (!d.lastRecResultAt) return 'text-muted-foreground';
    const idle = Date.now() - d.lastRecResultAt;
    if (idle < 5000) return 'text-emerald-400';
    if (idle < 15000) return 'text-amber-400';
    return 'text-red-400';
  }

  function wsColor(s: string): string {
    if (s === 'open') return 'text-emerald-400';
    if (s === 'connecting') return 'text-amber-400';
    return 'text-red-400';
  }

  useEffect(() => {
    const a = agents.find((x) => x.id === agentId);
    if (a?.endpointingMs) endpointMsRef.current = a.endpointingMs;
  }, [agentId, agents]);

  async function ensureCtx() {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
    return ctxRef.current;
  }

  function isSpeaking() {
    const c = ctxRef.current;
    return !!c && c.currentTime < nextStartRef.current - 0.001 + SPEAK_GRACE && nextStartRef.current > 0;
  }

  function scheduleBuffer(ctx: AudioContext, decoded: AudioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    if (recDestRef.current) src.connect(recDestRef.current); // capture into recording
    const start = Math.max(ctx.currentTime + 0.02, nextStartRef.current);
    src.start(start);
    nextStartRef.current = start + decoded.duration;
    sourcesRef.current.push(src);
    src.onended = () => {
      sourcesRef.current = sourcesRef.current.filter((s) => s !== src);
    };
  }

  async function playAudio(buf: ArrayBuffer) {
    const ctx = await ensureCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await ctx.decodeAudioData(buf.slice(0));
    } catch {
      return;
    }
    scheduleBuffer(ctx, decoded);
  }

  async function playPcm(bytes: Uint8Array, sampleRate: number, channels: number) {
    const ctx = await ensureCtx();
    const samples = Math.floor(bytes.byteLength / 2 / channels);
    if (samples === 0) return;
    const buffer = ctx.createBuffer(channels, samples, sampleRate);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let ch = 0; ch < channels; ch++) {
      const cd = buffer.getChannelData(ch);
      for (let i = 0; i < samples; i++) cd[i] = dv.getInt16((i * channels + ch) * 2, true) / 32768;
    }
    scheduleBuffer(ctx, buffer);
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
    nextStartRef.current = ctxRef.current ? ctxRef.current.currentTime : 0;
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
      if (recDestRef.current) srcNode.connect(recDestRef.current); // capture caller audio into recording
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      srcNode.connect(analyser);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(ctx.destination);

      const data = new Uint8Array(analyser.fftSize);
      let consec = 0;
      let baseline = 0.01;
      let lastUiUpdate = 0;
      const loop = () => {
        if (!liveRef.current) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (now - lastUiUpdate > 100) {
          lastUiUpdate = now;
          setDiag((d) => ({ ...d, micRms: rms, audioQueue: sourcesRef.current.length }));
        }
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

  function startRecognition() {
    const SR = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    const Rec = SR.SpeechRecognition || SR.webkitSpeechRecognition;
    if (!Rec) return;

    const spawn = () => {
      if (!liveRef.current) return;
      const rec = new Rec();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      baseIndexRef.current = 0;
      setDiag((d) => ({ ...d, recRunning: true, lastError: '' }));
      clientLog('recognition spawn', { restarts: diagRef.current.recRestarts });
      rec.onresult = (e: any) => {
        setDiag((d) => ({ ...d, lastRecResultAt: Date.now() }));
        resultsLenRef.current = e.results.length;
        if (isSpeaking()) {
          // Drop while agent talks, but only consume FINAL results — Chrome
          // may still be appending to the current in-progress result when the
          // user starts speaking, so we mustn't skip past it.
          for (let i = baseIndexRef.current; i < e.results.length; i++) {
            if (e.results[i].isFinal) baseIndexRef.current = i + 1;
          }
          return;
        }
        let full = '';
        for (let i = baseIndexRef.current; i < e.results.length; i++) full += e.results[i][0].transcript + ' ';
        full = full.trim();
        if (!full) return;
        interimRef.current = full;
        setInterim(full);
        // Only commit after the configured end-of-turn pause (silence).
        if (endpointTimer.current) clearTimeout(endpointTimer.current);
        endpointTimer.current = window.setTimeout(() => {
          if (interimRef.current && !isSpeaking()) send(interimRef.current);
        }, endpointMsRef.current);
      };
      rec.onerror = (ev: any) => {
        const err = ev?.error ?? 'unknown';
        clientLog('recognition error', { error: err }, err === 'no-speech' ? 'info' : 'warn');
        setDiag((d) => ({ ...d, lastError: `recognition: ${err}` }));
      };
      rec.onend = () => {
        clientLog('recognition ended');
        setDiag((d) => ({ ...d, recRunning: false, recRestarts: d.recRestarts + 1 }));
        if (liveRef.current) setTimeout(spawn, 100);
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch (e) {
        clientLog('recognition start threw', { error: String(e) }, 'error');
        if (liveRef.current) setTimeout(spawn, 300);
      }
    };
    spawn();
  }

  async function start() {
    if (!agentId) return;
    setStatus('connecting');
    setLines([]);
    setLatency(null);
    const ctx = await ensureCtx();
    liveRef.current = true;
    // Set up the recording mixer (mic + agent audio).
    recDestRef.current = ctx.createMediaStreamDestination();
    recChunksRef.current = [];
    callIdRef.current = null;
    const mime = pickRecorderMime();
    try {
      recorderRef.current = new MediaRecorder(recDestRef.current.stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current.ondataavailable = (e) => { if (e.data.size > 0) recChunksRef.current.push(e.data); };
      recorderRef.current.start(1000); // 1s timeslices for safety
    } catch {
      recorderRef.current = null;
    }
    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/call?agentId=${agentId}&token=${encodeURIComponent(token ?? '')}&customer_name=${encodeURIComponent(customer)}${sttMode === 'flux' ? '&stt=flux' : ''}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    setDiag((d) => ({ ...d, wsState: 'connecting' }));
    ws.onopen = () => {
      setStatus('live');
      callStartRef.current = Date.now();
      setDiag((d) => ({ ...d, wsState: 'open' }));
      clientLog('ws open', { agentId, voice: agents.find((a) => a.id === agentId)?.name, sttMode });
      startVad().then(() => {
        if (sttMode === 'flux') startFluxCapture();
        else startRecognition();
      });
    };
    ws.onclose = (e) => {
      setDiag((d) => ({
        ...d,
        wsState: 'closed',
        lastError: liveRef.current
          ? `ws closed (code ${e.code}${e.reason ? ` ${e.reason}` : ''})`
          : d.lastError,
      }));
      if (liveRef.current) stop('ws-closed');
    };
    ws.onerror = () => setDiag((d) => ({ ...d, lastError: 'ws error' }));
    ws.onmessage = (e) => {
      setDiag((d) => ({ ...d, lastEventAt: Date.now() }));
      if (typeof e.data !== 'string') {
        playAudio(e.data as ArrayBuffer);
        return;
      }
      const ev = JSON.parse(e.data);
      if (ev.type === 'audioPcm') {
        const bin = atob(ev.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        playPcm(bytes, ev.sampleRate ?? 24000, ev.channels ?? 1);
        return;
      }
      if (ev.type === 'meta') callIdRef.current = ev.callId;
      else if (ev.type === 'state') setDiag((d) => ({ ...d, engineState: ev.state }));
      else if (ev.type === 'transcript') {
        // In browser STT mode we already committed the user line optimistically;
        // in flux mode the server is the source of truth and we show its transcript.
        if (ev.role === 'user' && sttModeRef.current !== 'flux') return;
        setLines((l) => [
          ...l,
          { role: ev.role, text: ev.text, ts: Date.now() - (callStartRef.current || Date.now()) },
        ]);
      }
      else if (ev.type === 'flush') stopAudio();
      else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) setLatency(ev.turn.endpointToFirstAudio);
      else if (ev.type === 'ended') {
        setLines((l) => [...l, { role: 'system', text: endedLabel(ev.reason), ts: Date.now() - (callStartRef.current || Date.now()) }]);
        stop('server-ended');
      }
    };
    wsRef.current = ws;
  }

  function stop(reason: string = 'manual') {
    liveRef.current = false;
    if (vadRaf.current) cancelAnimationFrame(vadRaf.current);
    if (endpointTimer.current) clearTimeout(endpointTimer.current);
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;

    // Finalize the recording and upload it.
    const recorder = recorderRef.current;
    const callId = callIdRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = async () => {
        if (!callId || recChunksRef.current.length === 0) return;
        const type = recChunksRef.current[0]?.type || 'audio/webm';
        const blob = new Blob(recChunksRef.current, { type });
        try {
          await fetch(`/api/calls/${callId}/recording`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${getToken() ?? ''}`,
              'content-type': type,
            },
            body: blob,
          });
        } catch {
          /* best-effort */
        }
        recChunksRef.current = [];
      };
      try { recorder.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    recDestRef.current = null;

    stopFluxCapture();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setInterim('');
    interimRef.current = '';
    stopAudio();
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'hangup', reason }));
    wsRef.current?.close();
    wsRef.current = null;
    setDiag((d) => ({ ...d, wsState: 'closed' }));
    setStatus('idle');
  }

  function send(t: string) {
    const body = t.trim();
    if (!body || wsRef.current?.readyState !== 1) return;
    if (lastSent.current.text === body && Date.now() - lastSent.current.t < 2500) {
      // dupe send (Chrome's late real-final following our pause-finalizer);
      // clear interim so the UI doesn't get stuck displaying it.
      interimRef.current = '';
      setInterim('');
      return;
    }
    lastSent.current = { text: body, t: Date.now() };
    if (endpointTimer.current) {
      clearTimeout(endpointTimer.current);
      endpointTimer.current = null;
    }
    baseIndexRef.current = resultsLenRef.current; // consume what we just sent
    interimRef.current = '';
    setInterim('');
    stopAudio();
    // Optimistic local commit — we know what the user said; don't wait for the
    // server's transcript echo (it can stall and leave the line never showing).
    setLines((l) => [
      ...l,
      { role: 'user', text: body, ts: Date.now() - (callStartRef.current || Date.now()) },
    ]);
    wsRef.current.send(JSON.stringify({ type: 'userText', text: body }));
    setText('');
  }

  const live = status === 'live' || status === 'connecting';

  return (
    <div className="space-y-8 fade-up">
      <header>
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">Live · Test Call</div>
        <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
          Step <span className="italic text-aurora">into</span> the call
        </h1>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-md leading-relaxed">
          Pick a voice, name the caller, and speak. The agent will listen, interrupt, and hang up on its own.
        </p>
      </header>

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
          <div className="space-y-1">
            <Label>STT</Label>
            <Select
              value={sttMode}
              onChange={(e) => setSttMode(e.target.value as 'browser' | 'flux')}
              className="w-44"
              disabled={live}
            >
              <option value="browser">Browser (default)</option>
              <option value="flux">Server · Deepgram Flux</option>
            </Select>
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
            <span className="flex items-center gap-2.5 text-[12px] tracking-tight text-emerald-300/95">
              <span className="breath inline-block h-2 w-2 rounded-full bg-emerald-400/90" />
              <span className="italic font-display text-[15px]">Live</span>
              <span className="text-muted-foreground">— just talk</span>
            </span>
          )}
          {latency != null && (
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80">
              first audio · <span className="text-foreground/85">{latency}ms</span>
            </span>
          )}
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
          {lines.map((l, i) => {
            if (l.role === 'system') {
              return (
                <div key={i} className="text-center py-2">
                  <span className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70 italic font-display normal-case">
                    {l.text}
                  </span>
                </div>
              );
            }
            const prev = i > 0 ? lines[i - 1] : null;
            const responseMs =
              prev && prev.role === 'user' && l.role === 'assistant' ? l.ts - prev.ts : null;
            return (
              <div key={i}>
                {responseMs != null && (
                  <div className="flex items-center gap-2 ml-20 my-1">
                    <span className="h-px w-6 bg-white/[0.06]" />
                    <span className={`text-[10px] uppercase tracking-[0.18em] tabular-nums font-mono ${latencyColor(responseMs)}`}>
                      ↳ {responseMs}ms
                    </span>
                  </div>
                )}
                <div className="flex gap-3 text-[14px] leading-relaxed py-1">
                  <div className="shrink-0 mt-0.5 w-20">
                    <div
                      className={
                        l.role === 'user'
                          ? 'text-[10px] uppercase tracking-[0.18em] text-aurora-2 font-medium'
                          : 'text-[10px] uppercase tracking-[0.18em] text-aurora-1 font-medium'
                      }
                    >
                      {l.role === 'user' ? 'You' : 'Agent'}
                    </div>
                    <div className="text-[10px] font-mono tabular-nums text-muted-foreground/55 mt-0.5">
                      {fmtOffset(l.ts)}
                    </div>
                  </div>
                  <span className="text-foreground/90 flex-1">{l.text}</span>
                </div>
              </div>
            );
          })}
          {interim && (
            <div className="flex gap-3 text-[14px] leading-relaxed opacity-55 italic font-display">
              <span className="shrink-0 mt-0.5 text-[10px] uppercase tracking-[0.18em] text-aurora-2 font-medium w-14 not-italic font-sans">
                You
              </span>
              <span>{interim}…</span>
            </div>
          )}
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

      {status === 'live' && (
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle>Behind the scenes</CardTitle>
            <Button variant="outline" size="sm" onClick={restartRecognition}>
              <RotateCw className="h-3 w-3" /> Restart STT
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mic VU meter */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75">
                  Mic input
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {diag.micRms.toFixed(3)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/[0.04] border border-white/[0.04] overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-100 ${
                    diag.micRms > 0.05
                      ? 'bg-emerald-400/80'
                      : diag.micRms > 0.02
                        ? 'bg-aurora-3/70'
                        : 'bg-muted-foreground/30'
                  }`}
                  style={{ width: `${Math.min(100, diag.micRms * 400)}%` }}
                />
              </div>
            </div>

            <div className="hairline" />

            {/* State grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
              <DiagRow
                label="WebSocket"
                value={diag.wsState}
                valueClass={wsColor(diag.wsState)}
                sub={`event ${ago(diag.lastEventAt)}`}
                dot
              />
              <DiagRow label="Engine" value={diag.engineState} sub={ago(diag.lastEventAt)} />
              <DiagRow
                label="Recognition"
                value={diag.recRunning ? 'listening' : 'restarting'}
                valueClass={recHealthColor()}
                sub={`last result ${ago(diag.lastRecResultAt)}`}
              />
              <DiagRow
                label="Agent"
                value={isSpeaking() ? 'speaking' : 'silent'}
                sub={`queue ${diag.audioQueue}`}
              />
              <DiagRow label="Restarts" value={String(diag.recRestarts)} sub="since call start" />
            </div>

            {interim && (
              <>
                <div className="hairline" />
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75 mb-1">
                    Recognizer interim
                  </div>
                  <div className="text-[13px] italic font-display text-foreground/70">{interim}…</div>
                </div>
              </>
            )}

            {diag.lastError && (
              <div className="flex items-center gap-2 text-amber-400/90 text-[12px]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{diag.lastError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
