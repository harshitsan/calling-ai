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

interface Word { word: string; start: number; end: number; speaker?: number }

// Aurora-tinted speaker palette — same dot color stays with a speaker
// throughout the transcript so the eye can follow them.
const SPEAKER_PALETTE = [
  { bg: 'bg-aurora-1/15', text: 'text-aurora-1', border: 'border-aurora-1/30' },
  { bg: 'bg-aurora-2/15', text: 'text-aurora-2', border: 'border-aurora-2/30' },
  { bg: 'bg-emerald-400/15', text: 'text-emerald-400', border: 'border-emerald-400/30' },
  { bg: 'bg-amber-400/15', text: 'text-amber-400', border: 'border-amber-400/30' },
  { bg: 'bg-sky-400/15', text: 'text-sky-400', border: 'border-sky-400/30' },
  { bg: 'bg-rose-400/15', text: 'text-rose-400', border: 'border-rose-400/30' },
];
function speakerStyle(n: number) { return SPEAKER_PALETTE[n % SPEAKER_PALETTE.length]!; }
interface Notes {
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  decisions: string[];
  speakers: string[];
  speakerMap?: Record<string, string | null>;
}

/** Build a Speaker N → "Name" lookup from both the structured speakerMap
 *  and the legacy "Name (Speaker N)" strings — back-compat with notes
 *  written before the speakerMap field existed. */
function buildSpeakerNameLookup(notes: Notes | null): Record<number, string> {
  if (!notes) return {};
  const out: Record<number, string> = {};
  if (notes.speakerMap) {
    for (const [k, v] of Object.entries(notes.speakerMap)) {
      const n = Number(k);
      if (Number.isInteger(n) && typeof v === 'string' && v.trim().length > 0) {
        out[n] = v.trim();
      }
    }
  }
  for (const s of notes.speakers ?? []) {
    const m = s.match(/^(.+?)\s*\(\s*Speaker\s+(\d+)\s*\)\s*$/i);
    if (m) {
      const n = Number(m[2]);
      if (Number.isInteger(n) && !out[n]) out[n] = m[1]!.trim();
    }
  }
  return out;
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
            <TimestampedTranscript
              words={job.transcriptWords}
              speakerNames={buildSpeakerNameLookup(job.notes)}
            />
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

interface TranscriptLine { start: number; text: string; speaker?: number }
/**
 * Group words into lines. Always break on speaker change; otherwise break on
 * long silence, sentence end, or max length. This keeps each line attributable
 * to a single speaker for clean rendering.
 */
function groupIntoLines(words: Word[], maxSilenceSec = 1.5, maxWords = 28): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let current: Word[] = [];
  let currentSpeaker: number | undefined = undefined;
  const flush = () => {
    if (current.length === 0) return;
    lines.push({
      start: current[0]!.start,
      text: current.map((c) => c.word).join(' ').replace(/\s+([,.!?])/g, '$1'),
      speaker: currentSpeaker,
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = current[current.length - 1];
    const speakerChanged = current.length > 0 && w.speaker !== currentSpeaker;
    const longGap = prev && (w.start - prev.end > maxSilenceSec);
    const tooLong = current.length >= maxWords;
    const sentenceEnd = prev && /[.!?]$/.test(prev.word);
    if (speakerChanged || (current.length > 0 && (longGap || tooLong || sentenceEnd))) {
      flush();
    }
    if (current.length === 0) currentSpeaker = w.speaker;
    current.push(w);
  }
  flush();
  return lines;
}

function TimestampedTranscript({
  words,
  speakerNames = {},
}: {
  words: Word[];
  speakerNames?: Record<number, string>;
}) {
  const lines = useMemo(() => groupIntoLines(words), [words]);
  const hasSpeakers = useMemo(() => words.some((w) => typeof w.speaker === 'number'), [words]);
  const distinctSpeakers = useMemo(() => {
    const s = new Set<number>();
    for (const l of lines) if (typeof l.speaker === 'number') s.add(l.speaker);
    return Array.from(s).sort((a, b) => a - b);
  }, [lines]);

  const labelFor = (n: number) => speakerNames[n] ?? `Speaker ${n}`;

  return (
    <div>
      {hasSpeakers && distinctSpeakers.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/65">
            {distinctSpeakers.length} {distinctSpeakers.length === 1 ? 'speaker' : 'speakers'} detected
          </span>
          {distinctSpeakers.map((n) => {
            const s = speakerStyle(n);
            return (
              <Badge key={n} className={cn('border', s.bg, s.text, s.border)}>
                {labelFor(n)}
              </Badge>
            );
          })}
        </div>
      )}

      <div className="space-y-2.5 max-h-[520px] overflow-y-auto pr-2">
        {lines.map((l, i) => {
          const sp = l.speaker;
          const s = typeof sp === 'number' ? speakerStyle(sp) : null;
          return (
            <div key={i} className="flex gap-3 group">
              <span className={cn(
                'shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/55',
                'group-hover:text-aurora-1 transition-colors min-w-[44px] text-right pt-0.5',
              )}>
                {fmtTimestamp(l.start)}
              </span>
              <div className="min-w-0 flex-1">
                {s && typeof sp === 'number' && (
                  <span className={cn(
                    'inline-block mr-2 mb-1 rounded-full border px-2 py-[1px] text-[9px] uppercase tracking-[0.16em] align-baseline',
                    s.bg, s.text, s.border,
                  )}>
                    {labelFor(sp)}
                  </span>
                )}
                <p className="text-[13px] text-foreground/90 leading-relaxed font-serif inline">{l.text}</p>
              </div>
            </div>
          );
        })}
      </div>
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
