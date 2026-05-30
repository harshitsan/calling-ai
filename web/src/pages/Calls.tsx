import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface CallRow {
  id: string;
  agent_id: string | null;
  caller_ref: string | null;
  started_at: number;
  duration_s: number | null;
  status: string;
  end_reason: string | null;
  cost_usd: number | null;
  summary: string | null;
  latency_p50_ms: number | null;
}
interface AgentLite {
  id: string;
  name: string;
}

const STATUSES = [
  { id: 'all', label: 'All' },
  { id: 'ended', label: 'Ended' },
  { id: 'active', label: 'Active' },
] as const;
const END_REASONS = [
  { id: 'all', label: 'Any end' },
  { id: 'tool', label: 'Agent ended' },
  { id: 'manual', label: 'Manual hangup' },
  { id: 'disconnected', label: 'Disconnected' },
] as const;
const DATE_RANGES = [
  { id: 'all', label: 'All time', days: 0 },
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
] as const;

type StatusId = (typeof STATUSES)[number]['id'];
type EndId = (typeof END_REASONS)[number]['id'];
type DateId = (typeof DATE_RANGES)[number]['id'];

function endLabel(r: string | null): string {
  if (!r) return '—';
  if (r.startsWith('tool:')) return 'agent';
  if (r === 'client_hangup') return 'manual';
  if (r === 'socket_closed') return 'disconnect';
  return r;
}

export function Calls() {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [agentId, setAgentId] = useState('');
  const [status, setStatus] = useState<StatusId>('all');
  const [endReason, setEndReason] = useState<EndId>('all');
  const [dateRange, setDateRange] = useState<DateId>('all');

  useEffect(() => {
    api<{ agents: AgentLite[] }>('/api/agents').then((r) => setAgents(r.agents));
  }, []);

  const since = useMemo(() => {
    const cfg = DATE_RANGES.find((d) => d.id === dateRange);
    if (!cfg || cfg.days === 0) return 0;
    if (cfg.id === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    return Date.now() - cfg.days * 24 * 60 * 60 * 1000;
  }, [dateRange]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (agentId) params.set('agentId', agentId);
    if (status !== 'all') params.set('status', status);
    if (endReason !== 'all') params.set('endReason', endReason);
    if (since > 0) params.set('since', String(since));
    const qs = params.toString();
    const t = setTimeout(() => {
      api<{ calls: CallRow[] }>(`/api/calls${qs ? `?${qs}` : ''}`)
        .then((r) => setCalls(r.calls))
        .finally(() => setLoading(false));
    }, 200); // debounce for search typing
    return () => clearTimeout(t);
  }, [q, agentId, status, endReason, since]);

  const anyFilter = q || agentId || status !== 'all' || endReason !== 'all' || dateRange !== 'all';

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">Archive · Call Logs</div>
        <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
          Every <span className="italic text-aurora">conversation</span>
        </h1>
      </header>

      {/* Filter bar */}
      <div className="glass rounded-2xl p-5 mb-6 space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/70" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search caller or summary…"
              className="pl-9"
            />
          </div>
          <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-52">
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          {anyFilter && (
            <button
              type="button"
              className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground/95 transition-colors"
              onClick={() => {
                setQ('');
                setAgentId('');
                setStatus('all');
                setEndReason('all');
                setDateRange('all');
              }}
            >
              Clear
            </button>
          )}
        </div>

        <Chips group="status" options={STATUSES} value={status} onChange={(v) => setStatus(v as StatusId)} />
        <Chips group="end" options={END_REASONS} value={endReason} onChange={(v) => setEndReason(v as EndId)} />
        <Chips group="date" options={DATE_RANGES} value={dateRange} onChange={(v) => setDateRange(v as DateId)} />
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : calls.length === 0 ? (
        <Card className="py-20 text-center">
          <p className="font-display italic text-xl text-foreground/85">
            {anyFilter ? 'No calls match these filters.' : 'No calls yet.'}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {anyFilter ? 'Try widening the search.' : 'When an agent picks up, the story shows up here.'}
          </p>
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
                <th className="px-5 py-4 font-medium">End</th>
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
                  <td className="px-5 py-4 text-muted-foreground tabular-nums">
                    {c.cost_usd != null ? `$${c.cost_usd.toFixed(4)}` : '—'}
                  </td>
                  <td className="px-5 py-4 text-muted-foreground">{endLabel(c.end_reason)}</td>
                  <td className="px-5 py-4">
                    <Badge>{c.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

interface ChipOpt {
  id: string;
  label: string;
}
function Chips({
  group,
  options,
  value,
  onChange,
}: {
  group: string;
  options: readonly ChipOpt[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60 w-14">{group}</span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-full border px-3 py-1 text-[11px] tracking-tight transition-all',
            value === o.id
              ? 'bg-white/[0.07] border-white/[0.12] text-foreground/95'
              : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground/90 hover:bg-white/[0.04]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
