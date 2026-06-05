import { CheckCircle2, FileAudio, Loader2, Plus, Sparkles, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';

interface NotetakerJob {
  id: string;
  title: string;
  status: 'queued' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
  error?: string;
  chars: number | null;
  audioSizeBytes: number;
  audioDurationSec: number | null;
  createdAt: number;
  completedAt: number | null;
  notes?: { summary?: string } | null;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(s: number | null): string {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function fmtAge(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function Notetaker() {
  const [items, setItems] = useState<NotetakerJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function refresh() {
    const r = await api<{ notetaker: NotetakerJob[] }>('/api/notetaker');
    setItems(r.notetaker);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  // Poll while any job is in-flight so the UI tracks completion without a refresh.
  useEffect(() => {
    const inFlight = items.some(
      (i) => i.status === 'queued' || i.status === 'transcribing' || i.status === 'summarizing',
    );
    if (!inFlight) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [items]);

  async function remove(id: string) {
    if (!confirm('Delete this transcript and audio?')) return;
    setDeletingId(id);
    try {
      await api(`/api/notetaker/${id}`, { method: 'DELETE' });
      setItems((cur) => cur.filter((v) => v.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Workspace · Notetaker
        </div>
        <div className="flex items-end justify-between gap-6">
          <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
            Meeting <span className="italic text-aurora">notes</span>
          </h1>
          <Button asChild>
            <Link to="/notetaker/new">
              <Plus className="h-4 w-4" /> Upload recording
            </Link>
          </Button>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-md leading-relaxed">
          Drop an audio file. Get back a transcript with timestamps, a summary, action items, and decisions.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="py-20 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-aurora-2 opacity-70" />
          <p className="mt-4 font-display italic text-xl text-foreground/90">No notes yet.</p>
          <p className="text-sm text-muted-foreground mt-1">Upload a meeting recording to get started.</p>
          <div className="mt-6">
            <Button asChild>
              <Link to="/notetaker/new"><Plus className="h-4 w-4" /> Upload recording</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 stagger">
          {items.map((v) => (
            <Link key={v.id} to={`/notetaker/${v.id}`} className="group block">
              <Card className="p-5 hover:-translate-y-0.5 transition-transform duration-300">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-display text-xl tracking-tight text-foreground/95 truncate group-hover:text-aurora transition-colors">
                        {v.title || 'Untitled recording'}
                      </h3>
                      <StatusBadge status={v.status} />
                    </div>
                    {v.notes?.summary && (
                      <p className="text-[12px] text-muted-foreground line-clamp-2 leading-relaxed">
                        {v.notes.summary}
                      </p>
                    )}
                    {v.status === 'failed' && v.error && (
                      <p className="text-[11px] text-red-400/80 italic mt-1">{v.error}</p>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(v.id); }}
                    disabled={deletingId === v.id}
                    className="shrink-0 h-8 w-8 rounded-full border border-white/[0.08] bg-white/[0.02] hover:bg-red-500/10 hover:border-red-500/20 hover:text-red-400 text-muted-foreground transition-colors flex items-center justify-center disabled:opacity-40"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="hairline my-3" />
                <div className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 flex-wrap">
                  <span className="flex items-center gap-1.5">
                    <FileAudio className="h-3 w-3" /> {fmtSize(v.audioSizeBytes)}
                  </span>
                  <span>{fmtDuration(v.audioDurationSec)}</span>
                  <span>{v.chars ? `${v.chars} chars` : '—'}</span>
                  <span className="opacity-60">{fmtAge(v.createdAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: NotetakerJob['status'] }) {
  if (status === 'ready') {
    return (
      <Badge className="bg-emerald-400/15 text-emerald-400 border-emerald-400/20 inline-flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3" /> ready
      </Badge>
    );
  }
  if (status === 'failed') {
    return (
      <Badge className="bg-red-500/15 text-red-400 border-red-500/20 inline-flex items-center gap-1">
        <XCircle className="h-3 w-3" /> failed
      </Badge>
    );
  }
  // queued / transcribing / summarizing
  return (
    <Badge className="bg-aurora-1/15 text-aurora-1 border-aurora-1/20 inline-flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> {status}
    </Badge>
  );
}
