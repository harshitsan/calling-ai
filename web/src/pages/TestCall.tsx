import { AlertTriangle, Phone, PhoneOff, Send } from 'lucide-react';
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
    captureRunning: false,
    lastSttAt: 0,
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
  const micStreamRef = useRef<MediaStream | null>(null);
  const vadRaf = useRef<number | null>(null);
  const recDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const callIdRef = useRef<string | null>(null);
  const callStartRef = useRef(0);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

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

  // Heartbeat keeps the WebSocket alive through silent stretches.
  useEffect(() => {
    if (status !== 'live') return;
    const id = setInterval(() => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }
    }, 15000);
    return () => clearInterval(id);
  }, [status]);

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
    if (recDestRef.current) src.connect(recDestRef.current);
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
      try { s.stop(); } catch { /* ignore */ }
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
      if (recDestRef.current) srcNode.connect(recDestRef.current);
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
      /* mic denied: barge-in disabled; text input still works */
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
          wsRef.current.send(e.data as ArrayBuffer);
        }
      };
      source.connect(worklet);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      worklet.connect(sink);
      sink.connect(ctx.destination);
      workletNodeRef.current = worklet;
      setDiag((d) => ({ ...d, captureRunning: true }));
      clientLog('flux capture started', { sampleRate: ctx.sampleRate });
    } catch (e) {
      clientLog('flux capture failed', { error: String(e) }, 'error');
      setDiag((d) => ({ ...d, lastError: `capture failed: ${String(e)}` }));
    }
  }

  function stopFluxCapture() {
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    workletNodeRef.current = null;
    try { captureCtxRef.current?.close(); } catch { /* ignore */ }
    captureCtxRef.current = null;
    setDiag((d) => ({ ...d, captureRunning: false }));
  }

  function clientLog(msg: string, data?: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') {
    if (wsRef.current?.readyState !== 1) return;
    try {
      wsRef.current.send(JSON.stringify({ type: 'client_log', msg, data, level }));
    } catch { /* ignore */ }
  }

  function ago(ts: number): string {
    if (!ts) return '—';
    const ms = Date.now() - ts;
    if (ms < 1000) return `${ms}ms ago`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s ago`;
    return `${Math.floor(ms / 60000)}m ago`;
  }

  function sttHealthColor(): string {
    const d = diagRef.current;
    if (!d.captureRunning) return 'text-red-400';
    if (!d.lastSttAt) return 'text-muted-foreground';
    const idle = Date.now() - d.lastSttAt;
    if (idle < 4000) return 'text-emerald-400';
    if (idle < 15000) return 'text-amber-400';
    return 'text-red-400';
  }

  function wsColor(s: string): string {
    if (s === 'open') return 'text-emerald-400';
    if (s === 'connecting') return 'text-amber-400';
    return 'text-red-400';
  }

  async function start() {
    if (!agentId) return;
    setStatus('connecting');
    setLines([]);
    setLatency(null);
    const ctx = await ensureCtx();
    liveRef.current = true;
    recDestRef.current = ctx.createMediaStreamDestination();
    recChunksRef.current = [];
    callIdRef.current = null;
    const mime = pickRecorderMime();
    try {
      recorderRef.current = new MediaRecorder(recDestRef.current.stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data);
      };
      recorderRef.current.start(1000);
    } catch {
      recorderRef.current = null;
    }
    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/call?agentId=${agentId}&token=${encodeURIComponent(token ?? '')}&customer_name=${encodeURIComponent(customer)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    setDiag((d) => ({ ...d, wsState: 'connecting' }));
    ws.onopen = () => {
      setStatus('live');
      callStartRef.current = Date.now();
      setDiag((d) => ({ ...d, wsState: 'open' }));
      clientLog('ws open', { agentId, voice: agents.find((a) => a.id === agentId)?.name });
      // Mic first (VAD + recording), then the Flux PCM pipeline.
      startVad().then(() => startFluxCapture());
    };
    ws.onclose = (e) => {
      setDiag((d) => ({
        ...d,
        wsState: 'closed',
        lastError: liveRef.current ? `ws closed (code ${e.code}${e.reason ? ` ${e.reason}` : ''})` : d.lastError,
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
      else if (ev.type === 'partial' && ev.role === 'user') {
        // Live interim from Flux — italic only, also drives barge-in.
        setInterim(ev.text);
        setDiag((d) => ({ ...d, lastSttAt: Date.now() }));
        if (isSpeaking() && ev.text.trim().length >= 2) bargeIn();
      } else if (ev.type === 'transcript') {
        setInterim('');
        setDiag((d) => ({ ...d, lastSttAt: Date.now() }));
        setLines((l) => [
          ...l,
          { role: ev.role, text: ev.text, ts: Date.now() - (callStartRef.current || Date.now()) },
        ]);
      } else if (ev.type === 'flush') {
        stopAudio();
      } else if (ev.type === 'latency' && ev.turn.endpointToFirstAudio != null) {
        setLatency(ev.turn.endpointToFirstAudio);
      } else if (ev.type === 'ended') {
        setLines((l) => [
          ...l,
          { role: 'system', text: endedLabel(ev.reason), ts: Date.now() - (callStartRef.current || Date.now()) },
        ]);
        stop('server-ended');
      }
    };
    wsRef.current = ws;
  }

  function stop(reason: string = 'manual') {
    liveRef.current = false;
    if (vadRaf.current) cancelAnimationFrame(vadRaf.current);
    stopFluxCapture();

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
        } catch { /* best-effort */ }
        recChunksRef.current = [];
      };
      try { recorder.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    recDestRef.current = null;

    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setInterim('');
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
    stopAudio(); // typing interrupts the agent
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
          {status === 'idle' ? (
            <Button onClick={start} disabled={!agentId}>
              <Phone className="h-4 w-4" /> Start call
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => stop('manual')}>
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
            <div className="flex gap-3 text-[14px] leading-relaxed opacity-55 italic font-display py-1">
              <span className="shrink-0 mt-0.5 text-[10px] uppercase tracking-[0.18em] text-aurora-2 font-medium w-20 not-italic font-sans">
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
          <CardHeader>
            <CardTitle>Behind the scenes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75">Mic input</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{diag.micRms.toFixed(3)}</span>
              </div>
              <div className="h-2 rounded-full bg-white/[0.04] border border-white/[0.04] overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-100 ${
                    diag.micRms > 0.05 ? 'bg-emerald-400/80' : diag.micRms > 0.02 ? 'bg-aurora-3/70' : 'bg-muted-foreground/30'
                  }`}
                  style={{ width: `${Math.min(100, diag.micRms * 400)}%` }}
                />
              </div>
            </div>

            <div className="hairline" />

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
                label="Flux STT"
                value={diag.captureRunning ? 'streaming' : 'stopped'}
                valueClass={sttHealthColor()}
                sub={`last result ${ago(diag.lastSttAt)}`}
              />
              <DiagRow
                label="Agent"
                value={isSpeaking() ? 'speaking' : 'silent'}
                sub={`queue ${diag.audioQueue}`}
              />
            </div>

            {interim && (
              <>
                <div className="hairline" />
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75 mb-1">
                    Server STT interim
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
