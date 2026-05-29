import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

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
}

export function CallDetail() {
  const { id } = useParams();
  const [call, setCall] = useState<CallFull | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);

  useEffect(() => {
    api<{ call: CallFull; turns: Turn[] }>(`/api/calls/${id}`).then((r) => {
      setCall(r.call);
      setTurns(r.turns);
    });
  }, [id]);

  if (!call) return <p className="text-muted-foreground">Loading…</p>;

  const endLabel = (r: string | null) => {
    if (!r) return '—';
    if (r.startsWith('tool:')) return `agent (end_call)`;
    if (r === 'client_hangup') return 'manual hangup';
    if (r === 'socket_closed') return 'disconnected';
    return r;
  };

  return (
    <div className="space-y-6">
      <Link to="/calls" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> Back to calls
      </Link>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Duration" value={call.duration_s != null ? `${call.duration_s}s` : '—'} />
        <Stat label="Latency p50" value={call.latency_p50_ms != null ? `${call.latency_p50_ms}ms` : '—'} />
        <Stat label="Cost" value={call.cost_usd != null ? `$${call.cost_usd.toFixed(4)}` : '—'} />
        <Stat label="Ended" value={endLabel(call.end_reason)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{call.summary || 'No summary.'}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transcript</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {turns.length === 0 && <p className="text-sm text-muted-foreground">No transcript.</p>}
          {turns.map((t, i) => (
            <div key={i} className="text-sm">
              <span className={t.role === 'user' ? 'text-blue-600 font-medium' : 'text-emerald-700 font-medium'}>
                {t.role === 'user' ? 'Caller' : 'Agent'}:
              </span>{' '}
              {t.text}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
