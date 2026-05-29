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
    <div>
      <h1 className="text-2xl font-semibold mb-6">Call Logs</h1>
      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : calls.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">No calls yet.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-muted-foreground">
                <tr>
                  <th className="p-3">Started</th>
                  <th className="p-3">Caller</th>
                  <th className="p-3">Dur</th>
                  <th className="p-3">Latency</th>
                  <th className="p-3">Cost</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id} className="border-b hover:bg-accent/50">
                    <td className="p-3">
                      <Link to={`/calls/${c.id}`} className="hover:underline">
                        {new Date(c.started_at).toLocaleString()}
                      </Link>
                    </td>
                    <td className="p-3">{c.caller_ref ?? '—'}</td>
                    <td className="p-3">{c.duration_s != null ? `${c.duration_s}s` : '—'}</td>
                    <td className="p-3">{c.latency_p50_ms != null ? `${c.latency_p50_ms}ms` : '—'}</td>
                    <td className="p-3">{c.cost_usd != null ? `$${c.cost_usd.toFixed(4)}` : '—'}</td>
                    <td className="p-3">
                      <Badge>{c.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
