import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';

interface CallRow {
  id: string;
  caller_ref: string | null;
  started_at: number;
  duration_s: number | null;
  status: string;
  end_reason: string | null;
  cost_usd: number | null;
  summary: string | null;
  latency_p50_ms: number | null;
}

export function Calls() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ calls: CallRow[] }>('/api/calls')
      .then((r) => setCalls(r.calls))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">Archive · Call Logs</div>
        <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
          Every <span className="italic text-aurora">conversation</span>
        </h1>
      </header>
      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : calls.length === 0 ? (
        <Card className="py-20 text-center">
          <p className="font-display italic text-xl text-foreground/85">No calls yet.</p>
          <p className="text-sm text-muted-foreground mt-1">When an agent picks up, the story shows up here.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="text-left">
              <tr className="border-b border-white/[0.05] text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                <th className="px-5 py-4 font-medium">Started</th>
                <th className="px-5 py-4 font-medium">Caller</th>
                <th className="px-5 py-4 font-medium">Duration</th>
                <th className="px-5 py-4 font-medium">Latency</th>
                <th className="px-5 py-4 font-medium">Cost</th>
                <th className="px-5 py-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors">
                  <td className="px-5 py-4">
                    <Link to={`/calls/${c.id}`} className="text-foreground/90 hover:text-aurora transition-colors">
                      {new Date(c.started_at).toLocaleString()}
                    </Link>
                  </td>
                  <td className="px-5 py-4 text-foreground/80">{c.caller_ref ?? '—'}</td>
                  <td className="px-5 py-4 text-muted-foreground">{c.duration_s != null ? `${c.duration_s}s` : '—'}</td>
                  <td className="px-5 py-4 text-muted-foreground">{c.latency_p50_ms != null ? `${c.latency_p50_ms}ms` : '—'}</td>
                  <td className="px-5 py-4 text-muted-foreground tabular-nums">{c.cost_usd != null ? `$${c.cost_usd.toFixed(4)}` : '—'}</td>
                  <td className="px-5 py-4"><Badge>{c.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
