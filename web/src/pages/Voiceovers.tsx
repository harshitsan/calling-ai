import { Mic, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, getToken } from '@/lib/api';
import { languageLabel } from '@/lib/voices';

interface Voiceover {
  id: string;
  title: string;
  scriptText: string;
  voiceId: string;
  model: string;
  language: string;
  format: 'mp3' | 'wav';
  chars: number;
  durationMs: number | null;
  status: 'rendering' | 'ready' | 'failed';
  error?: string;
  createdAt: number;
  audioUrl: string;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${rem.toString().padStart(2, '0')}` : `0:${rem.toString().padStart(2, '0')}`;
}

function fmtAge(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function Voiceovers() {
  const [items, setItems] = useState<Voiceover[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    api<{ voiceovers: Voiceover[] }>('/api/voiceovers')
      .then((r) => setItems(r.voiceovers))
      .finally(() => setLoading(false));
  }, []);

  async function remove(id: string) {
    if (!confirm('Delete this voiceover?')) return;
    setDeletingId(id);
    try {
      await api(`/api/voiceovers/${id}`, { method: 'DELETE' });
      setItems((cur) => cur.filter((v) => v.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  function audioSrcFor(v: Voiceover): string {
    const t = getToken();
    return t ? `${v.audioUrl}?_t=${encodeURIComponent(t)}` : v.audioUrl;
  }

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Workspace · Voiceovers
        </div>
        <div className="flex items-end justify-between gap-6">
          <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
            Voice <span className="italic text-aurora">overs</span>
          </h1>
          <Button asChild>
            <Link to="/voiceovers/new">
              <Plus className="h-4 w-4" /> New voiceover
            </Link>
          </Button>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-md leading-relaxed">
          Async voice renders for video. Quality first, language-routed to the best provider.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="py-20 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-aurora-2 opacity-70" />
          <p className="mt-4 font-display italic text-xl text-foreground/90">No voiceovers yet.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Paste a script, pick a voice, get an audio file.
          </p>
          <div className="mt-6">
            <Button asChild>
              <Link to="/voiceovers/new">
                <Plus className="h-4 w-4" /> Render your first voiceover
              </Link>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 stagger">
          {items.map((v) => (
            <Card key={v.id} className="p-5">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-display text-xl tracking-tight text-foreground/95 truncate">
                      {v.title || 'Untitled voiceover'}
                    </h3>
                    {v.status === 'failed' && (
                      <Badge className="bg-red-500/15 text-red-400 border-red-500/20">failed</Badge>
                    )}
                    {v.status === 'ready' && (
                      <Badge className="bg-aurora-1/15 text-aurora-1 border-aurora-1/20">
                        {v.format.toUpperCase()}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1.5 text-[12px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {v.scriptText}
                  </p>
                </div>
                <button
                  onClick={() => remove(v.id)}
                  disabled={deletingId === v.id}
                  className="shrink-0 h-8 w-8 rounded-full border border-white/[0.08] bg-white/[0.02] hover:bg-red-500/10 hover:border-red-500/20 hover:text-red-400 text-muted-foreground transition-colors flex items-center justify-center disabled:opacity-40"
                  aria-label="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {v.status === 'ready' && (
                <audio
                  src={audioSrcFor(v)}
                  controls
                  preload="none"
                  className="w-full h-9 mt-1"
                  style={{ colorScheme: 'dark' }}
                />
              )}
              {v.status === 'failed' && v.error && (
                <p className="text-[11px] text-red-400/80 mt-1 italic">{v.error}</p>
              )}

              <div className="hairline my-4" />
              <div className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <Mic className="h-3 w-3" />
                  {v.voiceId.includes(':') ? v.voiceId.split(':')[1] : v.voiceId}
                </span>
                <span>{languageLabel(v.language)}</span>
                <span>{fmtDuration(v.durationMs)} · {v.chars} chars</span>
                <span className="opacity-60">{fmtAge(v.createdAt)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
