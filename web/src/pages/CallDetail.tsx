import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, getToken } from '@/lib/api';

interface Turn {
  role: string;
  text: string;
  ts: number;
}
interface CallFull {
  id: string;
  caller_ref: string | null;
  duration_s: number | null;
  cost_usd: number | null;
  end_reason: string | null;
  summary: string | null;
  latency_p50_ms: number | null;
  recording_key: string | null;
}

export function CallDetail() {
  const { id } = useParams();
  const [call, setCall] = useState<CallFull | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ call: CallFull; turns: Turn[] }>(`/api/calls/${id}`).then((r) => {
      setCall(r.call);
      setTurns(r.turns);
    });
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [id]);

  useEffect(() => {
    if (!call?.recording_key) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/calls/${id}/recording`, {
          headers: { authorization: `Bearer ${getToken() ?? ''}` },
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setAudioUrl(url);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call?.recording_key, id]);

  if (!call) return <p className="text-muted-foreground">Loading…</p>;

  const endLabel = (r: string | null) => {
    if (!r) return '—';
    if (r.startsWith('tool:')) return `agent (end_call)`;
    if (r === 'client_hangup') return 'manual hangup';
    if (r === 'socket_closed') return 'disconnected';
    return r;
  };

  return (
    <div className="space-y-8 fade-up">
      <Link to="/calls" className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-muted-foreground hover:text-foreground/95 transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to calls
      </Link>

      <div>
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-2">Call</div>
        <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
          <span className="italic text-aurora">{call.caller_ref ?? 'Unknown caller'}</span>
        </h1>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 stagger">
        <Stat label="Duration" value={call.duration_s != null ? `${call.duration_s}s` : '—'} />
        <Stat label="Latency p50" value={call.latency_p50_ms != null ? `${call.latency_p50_ms}ms` : '—'} />
        <Stat label="Cost" value={call.cost_usd != null ? `$${call.cost_usd.toFixed(4)}` : '—'} />
        <Stat label="Ended" value={endLabel(call.end_reason)} />
      </div>

      {call.recording_key && (
        <Card>
          <CardHeader>
            <CardTitle>Recording</CardTitle>
          </CardHeader>
          <CardContent>
            {audioUrl ? (
              <audio
                controls
                src={audioUrl}
                className="w-full [&::-webkit-media-controls-panel]:bg-white/[0.04] [&::-webkit-media-controls-panel]:rounded-md"
              />
            ) : (
              <p className="text-sm text-muted-foreground italic font-display">Loading recording…</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="font-display italic text-[17px] leading-relaxed text-foreground/85">
          {call.summary || 'No summary.'}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {turns.length === 0 && <p className="text-sm text-muted-foreground italic font-display">No transcript.</p>}
          {turns.map((t, i) => (
            <div key={i} className="flex gap-3 text-[14px] leading-relaxed">
              <span
                className={
                  t.role === 'user'
                    ? 'shrink-0 mt-0.5 text-[10px] uppercase tracking-[0.18em] text-aurora-2 font-medium w-16'
                    : 'shrink-0 mt-0.5 text-[10px] uppercase tracking-[0.18em] text-aurora-1 font-medium w-16'
                }
              >
                {t.role === 'user' ? 'Caller' : 'Agent'}
              </span>
              <span className="text-foreground/90">{t.text}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/75">{label}</div>
      <div className="mt-2 font-display text-2xl tracking-tight text-foreground/95">{value}</div>
    </Card>
  );
}
