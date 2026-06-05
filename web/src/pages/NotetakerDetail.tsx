import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  RotateCw,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api, getToken } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Word { word: string; start: number; end: number }
interface Notes {
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  decisions: string[];
  speakers: string[];
}
interface NotetakerJob {
  id: string;
  title: string;
  status: 'queued' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
  error?: string;
  audioUrl: string;
  audioSizeBytes: number;
  audioDurationSec: number | null;
  transcriptText: string | null;
  transcriptWords: Word[];
  notes: Notes | null;
  chars: number | null;
  createdAt: number;
  completedAt: number | null;
}

function fmtTimestamp(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function NotetakerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<NotetakerJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  async function refresh() {
    if (!id) return;
    const r = await api<{ notetaker: NotetakerJob }>(`/api/notetaker/${id}`);
    setJob(r.notetaker);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!job) return;
    const inFlight = job.status === 'queued' || job.status === 'transcribing' || job.status === 'summarizing';
    if (!inFlight) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  const audioSrc = useMemo(() => {
    if (!job) return '';
    // <audio src> can't send Authorization headers; reuse the ?_t pattern.
    const t = getToken();
    return t ? `${job.audioUrl}?_t=${encodeURIComponent(t)}` : job.audioUrl;
  }, [job]);

  async function retry() {
    if (!id) return;
    setRetrying(true);
    try {
      await api(`/api/notetaker/${id}/retry`, { method: 'POST' });
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  async function remove() {
    if (!id || !confirm('Delete this transcript?')) return;
    await api(`/api/notetaker/${id}`, { method: 'DELETE' });
    navigate('/notetaker');
  }

  function copy(s: string) { navigator.clipboard?.writeText(s).catch(() => {}); }

  function downloadMd() {
    if (!job) return;
    const md = renderMarkdown(job);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(job.title || 'meeting-notes').replace(/\s+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <p className="text-sm text-muted-foreground italic font-display">Loading…</p>;
  if (!job) return <p className="text-sm text-red-400 italic">Not found.</p>;

  const isReady = job.status === 'ready';
  const isFailed = job.status === 'failed';
  const isWorking = job.status === 'queued' || job.status === 'transcribing' || job.status === 'summarizing';

  return (
    <div className="fade-up max-w-[960px]">
      <Link to="/notetaker" className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors mb-6">
        <ArrowLeft className="h-3.5 w-3.5" /> Notetaker
      </Link>

      <header className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
            Recording
          </div>
          <h1 className="font-display text-4xl tracking-tight leading-[0.95] truncate">
            {job.title || 'Untitled recording'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {isFailed && (
            <Button variant="outline" onClick={retry} disabled={retrying}>
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />} Retry
            </Button>
          )}
          {isReady && (
            <Button variant="outline" onClick={downloadMd}>
              <Download className="h-4 w-4" /> Markdown
            </Button>
          )}
          <Button variant="ghost" onClick={remove}>Delete</Button>
        </div>
      </header>

      <Card className="p-4 mb-6 flex items-center gap-4">
        <audio src={audioSrc} controls preload="none" className="flex-1 h-10" style={{ colorScheme: 'dark' }} />
        <StatusPill status={job.status} />
      </Card>

      {isWorking && (
        <Card className="p-6 text-center mb-6">
          <Loader2 className="mx-auto h-5 w-5 text-aurora-1 animate-spin mb-2" />
          <p className="font-display italic text-foreground/90">
            {job.status === 'queued' && 'Queued…'}
            {job.status === 'transcribing' && 'Transcribing the audio…'}
            {job.status === 'summarizing' && 'Reading the transcript and writing notes…'}
          </p>
          <p className="text-[11px] text-muted-foreground/70 mt-1">This page auto-refreshes.</p>
        </Card>
      )}

      {isFailed && (
        <Card className="p-5 mb-6 border-red-500/30 bg-red-500/5">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="h-4 w-4 text-red-400" />
            <span className="text-[12px] uppercase tracking-[0.22em] text-red-400/90">Failed</span>
          </div>
          {job.error && <p className="text-[12px] text-red-400/80">{job.error}</p>}
        </Card>
      )}

      {isReady && job.notes && (
        <>
          <Card className="p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-aurora-1" />
              <span className="text-[10px] uppercase tracking-[0.22em] text-aurora-1">Summary</span>
              <SentimentBadge sentiment={job.notes.sentiment} />
            </div>
            <p className="text-[14px] text-foreground/95 leading-relaxed">{job.notes.summary || '—'}</p>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 mb-6">
            <NotesList title="Action items" items={job.notes.actionItems} icon={<CheckCircle2 className="h-3.5 w-3.5" />} />
            <NotesList title="Decisions" items={job.notes.decisions} />
            <NotesList title="Key topics" items={job.notes.keyTopics} />
            <NotesList title="Speakers" items={job.notes.speakers} />
          </div>
        </>
      )}

      {isReady && job.transcriptText && (
        <Card className="p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">Transcript</div>
            <button
              onClick={() => copy(job.transcriptText!)}
              className="text-[11px] flex items-center gap-1 text-muted-foreground hover:text-foreground/95 transition-colors"
            >
              <Copy className="h-3 w-3" /> Copy all
            </button>
          </div>
          {job.transcriptWords.length > 0 ? (
            <TimestampedTranscript words={job.transcriptWords} />
          ) : (
            <p className="text-[13px] text-foreground/90 leading-relaxed whitespace-pre-wrap font-serif">
              {job.transcriptText}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: NotetakerJob['status'] }) {
  if (status === 'ready') return <Badge className="bg-emerald-400/15 text-emerald-400 border-emerald-400/20">ready</Badge>;
  if (status === 'failed') return <Badge className="bg-red-500/15 text-red-400 border-red-500/20">failed</Badge>;
  return (
    <Badge className="bg-aurora-1/15 text-aurora-1 border-aurora-1/20 inline-flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> {status}
    </Badge>
  );
}

function SentimentBadge({ sentiment }: { sentiment: Notes['sentiment'] }) {
  const cls =
    sentiment === 'positive' ? 'bg-emerald-400/15 text-emerald-400 border-emerald-400/20'
    : sentiment === 'negative' ? 'bg-red-500/15 text-red-400 border-red-500/20'
    : sentiment === 'mixed' ? 'bg-amber-400/15 text-amber-400 border-amber-400/20'
    : 'bg-white/[0.06] text-muted-foreground border-white/[0.10]';
  return <Badge className={cls}>{sentiment}</Badge>;
}

function NotesList({ title, items, icon }: { title: string; items: string[]; icon?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3 flex items-center gap-1.5">
        {icon} {title}
      </div>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/60 italic">— none —</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="text-[13px] text-foreground/90 leading-relaxed before:content-['•'] before:text-aurora-1 before:mr-2">
              {it}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface TranscriptLine { start: number; text: string }
function groupIntoLines(words: Word[], maxSilenceSec = 1.5, maxWords = 24): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = current[current.length - 1];
    const breakOn = !prev
      ? false
      : (w.start - prev.end > maxSilenceSec) || current.length >= maxWords
        || /[.!?]$/.test(prev.word);
    if (breakOn && current.length > 0) {
      lines.push({ start: current[0]!.start, text: current.map((c) => c.word).join(' ').replace(/\s+([,.!?])/g, '$1') });
      current = [];
    }
    current.push(w);
  }
  if (current.length > 0) {
    lines.push({ start: current[0]!.start, text: current.map((c) => c.word).join(' ').replace(/\s+([,.!?])/g, '$1') });
  }
  return lines;
}

function TimestampedTranscript({ words }: { words: Word[] }) {
  const lines = useMemo(() => groupIntoLines(words), [words]);
  return (
    <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-2">
      {lines.map((l, i) => (
        <div key={i} className="flex gap-3 group">
          <span className={cn(
            'shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55',
            'group-hover:text-aurora-1 transition-colors min-w-[44px] text-right pt-0.5',
          )}>
            {fmtTimestamp(l.start)}
          </span>
          <p className="text-[13px] text-foreground/90 leading-relaxed font-serif">{l.text}</p>
        </div>
      ))}
    </div>
  );
}

function renderMarkdown(job: NotetakerJob): string {
  const lines: string[] = [];
  lines.push(`# ${job.title || 'Meeting notes'}\n`);
  if (job.completedAt) lines.push(`*Generated: ${new Date(job.completedAt).toLocaleString()}*\n`);
  if (job.notes) {
    lines.push(`## Summary\n\n${job.notes.summary || '—'}\n`);
    lines.push(`*Sentiment: ${job.notes.sentiment}*\n`);
    if (job.notes.actionItems.length) {
      lines.push('## Action items\n');
      for (const a of job.notes.actionItems) lines.push(`- ${a}`);
      lines.push('');
    }
    if (job.notes.decisions.length) {
      lines.push('## Decisions\n');
      for (const d of job.notes.decisions) lines.push(`- ${d}`);
      lines.push('');
    }
    if (job.notes.keyTopics.length) {
      lines.push('## Key topics\n');
      for (const k of job.notes.keyTopics) lines.push(`- ${k}`);
      lines.push('');
    }
    if (job.notes.speakers.length) {
      lines.push('## Speakers\n');
      for (const s of job.notes.speakers) lines.push(`- ${s}`);
      lines.push('');
    }
  }
  if (job.transcriptText) {
    lines.push('## Transcript\n');
    lines.push(job.transcriptText);
  }
  return lines.join('\n');
}
