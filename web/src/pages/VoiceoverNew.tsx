import {
  ArrowLeft,
  Gauge,
  Loader2,
  Mic,
  Pause as PauseIcon,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, getToken } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_CHARS = 5000;

const LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
] as const;

const DURATION_PRESETS = [
  { label: '15s', ms: 15_000 },
  { label: '30s', ms: 30_000 },
  { label: '60s', ms: 60_000 },
  { label: '2 min', ms: 120_000 },
  { label: '5 min', ms: 300_000 },
];

type Speed = 'slow' | 'normal' | 'fast';
const SPEEDS: { id: Speed; label: string }[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

const PREVIEW_TEXTS: Record<string, string> = {
  'en-US': "Hi, I'm {name}. Pleasure to meet you.",
  'en-GB': "Hello, I'm {name}. Lovely to meet you.",
  es: 'Hola, soy {name}. Encantado de conocerte.',
  fr: 'Bonjour, je suis {name}. Ravi de vous rencontrer.',
  de: 'Hallo, ich bin {name}. Schön, Sie kennenzulernen.',
  it: 'Ciao, sono {name}. Piacere di conoscerti.',
  pt: 'Olá, sou {name}. Prazer em conhecê-lo.',
  hi: 'नमस्ते, मैं {name} हूँ। आपसे मिलकर खुशी हुई।',
  ja: 'こんにちは、{name} です。お会いできて嬉しいです。',
  zh: '你好，我是 {name}。很高兴认识你。',
};

function previewTextFor(language: string, voiceName: string): string {
  const t =
    PREVIEW_TEXTS[language] ??
    PREVIEW_TEXTS[language.split('-')[0] ?? ''] ??
    PREVIEW_TEXTS['en-US']!;
  return t.replace('{name}', voiceName);
}

const MIN_SNIPPET_MS = 500;
const DEFAULT_SNIPPET_MS = 5_000;

interface Snippet {
  localId: string;
  startMs: number;
  durationMs: number;
  scriptText: string;
  voiceId: string;
  language: string;
  speed: Speed;
}

interface VoiceItem { id: string; label: string; gender?: 'female' | 'male' }
interface VoicesResponse {
  model: string;
  modelLabel: string;
  format: 'mp3' | 'wav';
  pricePerMinUsd: number;
  voices: VoiceItem[];
}
interface CreateResponse {
  voiceover: {
    id: string;
    audioUrl: string;
    durationMs: number | null;
    format: 'mp3' | 'wav';
    chars: number;
  };
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fmtMs(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

export function VoiceoverNew() {
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [totalDurationMs, setTotalDurationMs] = useState(30_000);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Voices cache keyed by language so switching a snippet is instant.
  const [voicesByLang, setVoicesByLang] = useState<Record<string, VoicesResponse>>({});
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male'>('all');
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResponse['voiceover'] | null>(null);

  const selected = useMemo(
    () => snippets.find((s) => s.localId === selectedId) ?? null,
    [snippets, selectedId],
  );

  // ----- Voices cache -----
  const loadVoicesFor = useCallback(async (lang: string) => {
    if (voicesByLang[lang]) return voicesByLang[lang];
    const r = await api<VoicesResponse>(`/api/voiceovers/voices?lang=${encodeURIComponent(lang)}`);
    setVoicesByLang((prev) => ({ ...prev, [lang]: r }));
    return r;
  }, [voicesByLang]);

  useEffect(() => {
    if (selected) loadVoicesFor(selected.language).catch(() => {});
  }, [selected, loadVoicesFor]);

  // Eagerly load en-US so the first snippet has voices ready.
  useEffect(() => {
    loadVoicesFor('en-US').catch(() => {});
  }, [loadVoicesFor]);

  useEffect(() => () => audioPreviewRef.current?.pause(), []);

  // ----- Snippet ops -----
  function sortedSnippets(arr: Snippet[]): Snippet[] {
    return [...arr].sort((a, b) => a.startMs - b.startMs);
  }

  function findGapAt(positionMs: number, arr: Snippet[]): { start: number; max: number } | null {
    const sorted = sortedSnippets(arr);
    let cur = 0;
    for (const s of sorted) {
      if (positionMs < s.startMs) {
        return { start: Math.max(cur, positionMs), max: s.startMs - Math.max(cur, positionMs) };
      }
      cur = Math.max(cur, s.startMs + s.durationMs);
    }
    if (positionMs >= cur) {
      return { start: Math.max(cur, positionMs), max: totalDurationMs - Math.max(cur, positionMs) };
    }
    return null;
  }

  function addSnippetAt(positionMs: number) {
    const gap = findGapAt(positionMs, snippets);
    if (!gap || gap.max < MIN_SNIPPET_MS) return;
    const duration = Math.min(DEFAULT_SNIPPET_MS, gap.max);
    const sorted = sortedSnippets(snippets);
    const prev = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
    const newSnip: Snippet = {
      localId: uid(),
      startMs: gap.start,
      durationMs: duration,
      scriptText: '',
      voiceId: prev?.voiceId ?? (voicesByLang['en-US']?.voices[0]?.id ?? 'aura2en:asteria'),
      language: prev?.language ?? 'en-US',
      speed: 'normal',
    };
    setSnippets((cur) => [...cur, newSnip]);
    setSelectedId(newSnip.localId);
    setResult(null);
  }

  function updateSnippet(id: string, patch: Partial<Snippet>) {
    setSnippets((cur) => cur.map((s) => (s.localId === id ? { ...s, ...patch } : s)));
    setResult(null);
  }

  function deleteSnippet(id: string) {
    setSnippets((cur) => cur.filter((s) => s.localId !== id));
    if (selectedId === id) setSelectedId(null);
    setResult(null);
  }

  // ----- Drag/resize on the timeline -----
  const trackRef = useRef<HTMLDivElement | null>(null);
  const msPerPx = useCallback(() => {
    const w = trackRef.current?.clientWidth ?? 1;
    return totalDurationMs / w;
  }, [totalDurationMs]);

  function neighborsFor(id: string, arr: Snippet[]): { prevEnd: number; nextStart: number } {
    const sorted = sortedSnippets(arr.filter((s) => s.localId !== id));
    const target = arr.find((s) => s.localId === id)!;
    let prevEnd = 0;
    let nextStart = totalDurationMs;
    for (const s of sorted) {
      if (s.startMs + s.durationMs <= target.startMs && s.startMs + s.durationMs > prevEnd) {
        prevEnd = s.startMs + s.durationMs;
      }
      if (s.startMs >= target.startMs + target.durationMs && s.startMs < nextStart) {
        nextStart = s.startMs;
      }
    }
    return { prevEnd, nextStart };
  }

  type DragKind = 'move' | 'resize';
  function beginDrag(e: React.PointerEvent<HTMLDivElement>, id: string, kind: DragKind) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const initial = snippets.find((s) => s.localId === id)!;
    const { prevEnd, nextStart } = neighborsFor(id, snippets);
    const mPpx = msPerPx();
    const targetEl = e.currentTarget as HTMLElement;
    try { targetEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setSelectedId(id);

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dms = Math.round(dx * mPpx);
      if (kind === 'move') {
        const minStart = prevEnd;
        const maxStart = nextStart - initial.durationMs;
        const next = Math.max(minStart, Math.min(maxStart, initial.startMs + dms));
        updateSnippet(id, { startMs: next });
      } else {
        const maxDur = nextStart - initial.startMs;
        const next = Math.max(MIN_SNIPPET_MS, Math.min(maxDur, initial.durationMs + dms));
        updateSnippet(id, { durationMs: next });
      }
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function onTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const positionMs = Math.max(0, Math.min(totalDurationMs - 1, Math.round(x * msPerPx())));
    addSnippetAt(positionMs);
  }

  // ----- Voice preview -----
  async function previewVoice(v: VoiceItem, language: string) {
    if (previewingId === v.id) {
      audioPreviewRef.current?.pause();
      setPreviewingId(null);
      return;
    }
    audioPreviewRef.current?.pause();
    setPreviewingId(v.id);
    try {
      const text = previewTextFor(language, v.label);
      const res = await fetch(
        `/api/tts?voice=${encodeURIComponent(v.id)}&text=${encodeURIComponent(text)}`,
      );
      if (!res.ok) { setPreviewingId(null); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioPreviewRef.current = audio;
      audio.onended = () => { setPreviewingId(null); URL.revokeObjectURL(url); };
      audio.onerror = () => { setPreviewingId(null); URL.revokeObjectURL(url); };
      await audio.play();
    } catch {
      setPreviewingId(null);
    }
  }

  // ----- Render -----
  async function renderProject() {
    if (snippets.length === 0) return;
    setRendering(true);
    setError(null);
    setResult(null);
    try {
      const payload = {
        title,
        totalDurationMs,
        snippets: snippets.map((s) => ({
          startMs: s.startMs,
          durationMs: s.durationMs,
          scriptText: s.scriptText,
          voiceId: s.voiceId,
          language: s.language,
          speed: s.speed,
        })),
      };
      const r = await api<CreateResponse>('/api/voiceovers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setResult(r.voiceover);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRendering(false);
    }
  }

  // ----- Derived render data -----
  const tickStep = totalDurationMs <= 30_000 ? 5_000 : totalDurationMs <= 120_000 ? 15_000 : 60_000;
  const ticks: number[] = [];
  for (let t = 0; t <= totalDurationMs; t += tickStep) ticks.push(t);

  const selectedVoices = selected ? voicesByLang[selected.language] : undefined;
  const selectedVoice = selected && selectedVoices
    ? selectedVoices.voices.find((v) => v.id === selected.voiceId)
    : undefined;
  const isGemini = selectedVoices?.model.startsWith('google/') ?? false;
  const hasGenderData = (selectedVoices?.voices ?? []).some((v) => v.gender);
  const filteredVoices = !selectedVoices
    ? []
    : !hasGenderData || genderFilter === 'all'
      ? selectedVoices.voices
      : selectedVoices.voices.filter((v) => v.gender === genderFilter);
  const genderGlyph = (g?: 'female' | 'male') => (g === 'female' ? '♀' : g === 'male' ? '♂' : '');

  const resultAudioSrc = useMemo(() => {
    if (!result) return '';
    const t = getToken();
    return t ? `${result.audioUrl}?_t=${encodeURIComponent(t)}` : result.audioUrl;
  }, [result]);

  const allValid = snippets.length > 0 && snippets.every((s) => s.scriptText.trim().length > 0);

  return (
    <div className="fade-up max-w-[1100px]">
      <Link
        to="/voiceovers"
        className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Voiceovers
      </Link>

      <header className="mb-8 flex items-end justify-between gap-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
            New Project · Timeline
          </div>
          <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
            Compose your <span className="italic text-aurora">voice</span>.
          </h1>
        </div>
        <Button
          onClick={renderProject}
          disabled={rendering || !allValid}
          title={!allValid ? 'Add at least one snippet and fill its script' : 'Render to a single audio file'}
        >
          {rendering ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Rendering…</>
          ) : (
            <><Sparkles className="h-4 w-4" /> {result ? 'Re-render' : 'Render project'}</>
          )}
        </Button>
      </header>

      {/* Project meta */}
      <Card className="p-5 mb-5 flex flex-wrap items-end gap-5">
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Product launch — hero clip"
            className="mt-1.5"
          />
        </div>
        <div>
          <Label>Project duration</Label>
          <div className="mt-1.5 flex gap-1.5">
            {DURATION_PRESETS.map((d) => (
              <button
                key={d.ms}
                type="button"
                onClick={() => {
                  if (snippets.some((s) => s.startMs + s.durationMs > d.ms)) {
                    if (!confirm('Some snippets extend past the new duration and will be trimmed. Continue?')) return;
                    setSnippets((cur) =>
                      cur
                        .filter((s) => s.startMs < d.ms)
                        .map((s) => ({
                          ...s,
                          durationMs: Math.min(s.durationMs, d.ms - s.startMs),
                        })),
                    );
                  }
                  setTotalDurationMs(d.ms);
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em] transition-all',
                  totalDurationMs === d.ms
                    ? 'bg-white/[0.07] border-white/[0.12] text-foreground/95'
                    : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground/90',
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Timeline */}
      <Card className="p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
            Timeline · click empty space to add a snippet
          </div>
          <span className="text-[11px] text-muted-foreground/70">
            {snippets.length}/{30} snippets · total {fmtMs(totalDurationMs)}
          </span>
        </div>

        {/* tick ruler */}
        <div className="relative h-5 mb-1 select-none">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 text-[9px] uppercase tracking-[0.18em] text-muted-foreground/50"
              style={{ left: `${(t / totalDurationMs) * 100}%`, transform: 'translateX(-50%)' }}
            >
              {fmtMs(t)}
            </div>
          ))}
        </div>

        {/* track */}
        <div
          ref={trackRef}
          onClick={onTrackClick}
          className="relative h-[88px] rounded-lg bg-white/[0.025] border border-white/[0.06] cursor-copy overflow-hidden"
        >
          {/* tick lines */}
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 bottom-0 w-px bg-white/[0.04]"
              style={{ left: `${(t / totalDurationMs) * 100}%` }}
            />
          ))}

          {snippets.map((s) => {
            const leftPct = (s.startMs / totalDurationMs) * 100;
            const widthPct = (s.durationMs / totalDurationMs) * 100;
            const isSelected = s.localId === selectedId;
            const voiceMeta = voicesByLang[s.language]?.voices.find((v) => v.id === s.voiceId);
            const voiceName = voiceMeta?.label ?? (s.voiceId.includes(':') ? s.voiceId.split(':')[1] : s.voiceId);
            return (
              <div
                key={s.localId}
                onPointerDown={(e) => beginDrag(e, s.localId, 'move')}
                onClick={(e) => { e.stopPropagation(); setSelectedId(s.localId); }}
                className={cn(
                  'absolute top-2 bottom-2 rounded-md overflow-hidden flex items-center px-3 gap-2 cursor-grab active:cursor-grabbing transition-colors',
                  isSelected
                    ? 'bg-aurora-1/20 border border-aurora-1/40 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.08)]'
                    : 'bg-white/[0.06] border border-white/[0.10] hover:bg-white/[0.09]',
                )}
                style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: 32 }}
                title={`${voiceName} · ${fmtMs(s.startMs)} → ${fmtMs(s.startMs + s.durationMs)}`}
              >
                <Mic className="h-3 w-3 shrink-0 opacity-70" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-display tracking-tight text-foreground/95 truncate">
                    {voiceName}
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 truncate">
                    {s.scriptText.trim() || <span className="italic">no script yet</span>}
                  </div>
                </div>
                <span className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60 shrink-0">
                  {fmtMs(s.durationMs)}
                </span>
                {/* resize handle */}
                <div
                  onPointerDown={(e) => beginDrag(e, s.localId, 'resize')}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-aurora-1/50 transition-colors"
                />
              </div>
            );
          })}

          {snippets.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-[12px] font-display italic text-muted-foreground/70">
                Click anywhere to add your first snippet
              </p>
            </div>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground/55 italic mt-2">
          Pitch may shift slightly when a snippet's natural pace differs from its slot — full
          pitch-preserving stretch comes in a future update.
        </p>
      </Card>

      {/* Snippet editor */}
      {selected ? (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
              Editing snippet · {fmtMs(selected.startMs)} → {fmtMs(selected.startMs + selected.durationMs)}
            </div>
            <button
              type="button"
              onClick={() => deleteSnippet(selected.localId)}
              className="text-[11px] text-muted-foreground hover:text-red-400 flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="h-3 w-3" /> Delete snippet
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-5 mb-4">
            <div>
              <Label htmlFor="lang">Language</Label>
              <Select
                id="lang"
                value={selected.language}
                onChange={(e) => updateSnippet(selected.localId, { language: e.target.value, voiceId: '' })}
                className="mt-1.5"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </Select>
              {selectedVoices && (
                <p className="mt-2 text-[11px] text-muted-foreground/75 leading-relaxed">
                  {selectedVoices.modelLabel}
                </p>
              )}
            </div>

            <div>
              <Label>Voice</Label>
              {!selectedVoices ? (
                <div className="mt-1.5 h-[42px] rounded-md bg-white/[0.03] border border-white/[0.07] flex items-center px-3 text-[12px] text-muted-foreground">
                  Loading voices…
                </div>
              ) : (
                <>
                  {hasGenderData && (
                    <div className="flex gap-1.5 mt-1.5 mb-2">
                      {(['all', 'female', 'male'] as const).map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => setGenderFilter(g)}
                          className={cn(
                            'rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] transition-all',
                            genderFilter === g
                              ? 'bg-white/[0.07] border-white/[0.12] text-foreground/95'
                              : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground/90',
                          )}
                        >
                          {g === 'female' ? '♀ Female' : g === 'male' ? '♂ Male' : 'All'}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Select
                      value={selected.voiceId || filteredVoices[0]?.id || ''}
                      onChange={(e) => updateSnippet(selected.localId, { voiceId: e.target.value })}
                      className="flex-1"
                    >
                      {filteredVoices.map((v) => {
                        const g = genderGlyph(v.gender);
                        return (
                          <option key={v.id} value={v.id}>
                            {g ? `${g}  ${v.label}` : v.label}
                          </option>
                        );
                      })}
                    </Select>
                    <button
                      type="button"
                      onClick={() => selectedVoice && previewVoice(selectedVoice, selected.language)}
                      className="shrink-0 h-10 w-10 rounded-md border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center"
                      aria-label="Preview voice"
                    >
                      {previewingId === selectedVoice?.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  {selectedVoice && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                      Selected: <span className="text-foreground/90">{selectedVoice.label}</span>
                      {selectedVoice.gender && (
                        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-white/[0.05] border border-white/[0.07] px-2 py-[1px] text-[10px] uppercase tracking-[0.16em] text-foreground/80">
                          {genderGlyph(selectedVoice.gender)} {selectedVoice.gender}
                        </span>
                      )}
                      {!selectedVoice.gender && (
                        <span className="ml-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/60">
                          gender unlabeled
                        </span>
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Script + pause inserts */}
          <div className="mb-4">
            <div className="flex items-baseline justify-between mb-1.5">
              <Label htmlFor="script">Script</Label>
              <span
                className={cn(
                  'text-[11px]',
                  selected.scriptText.length > MAX_CHARS ? 'text-red-400' : 'text-muted-foreground/60',
                )}
              >
                {selected.scriptText.length} / {MAX_CHARS} chars
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 mr-1">
                Insert pause
              </span>
              {(['short', 'medium', 'long'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    const token = `[pause:${k}]`;
                    updateSnippet(selected.localId, { scriptText: selected.scriptText + token });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground/95 hover:bg-white/[0.05] transition-colors"
                >
                  <PauseIcon className="h-3 w-3" /> {k}
                </button>
              ))}
            </div>
            <Textarea
              id="script"
              value={selected.scriptText}
              onChange={(e) => updateSnippet(selected.localId, { scriptText: e.target.value })}
              placeholder="What should this snippet say?"
              rows={5}
              className="font-serif leading-relaxed"
            />
          </div>

          {/* Speed + position controls */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label className="inline-flex items-center gap-1.5">
                <Gauge className="h-3 w-3" /> Speed
              </Label>
              <div className="mt-1.5 flex gap-1.5">
                {SPEEDS.map((sp) => (
                  <button
                    key={sp.id}
                    type="button"
                    onClick={() => updateSnippet(selected.localId, { speed: sp.id })}
                    className={cn(
                      'rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.18em] transition-all',
                      selected.speed === sp.id
                        ? 'bg-white/[0.07] border-white/[0.12] text-foreground/95'
                        : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground/90',
                    )}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
              {!isGemini && selected.speed !== 'normal' && selectedVoices && (
                <p className="mt-1.5 text-[10px] text-amber-400/80 italic">
                  Aura voices have a fixed pace — switch to a Gemini-routed language for true speed control.
                </p>
              )}
            </div>
            <div>
              <Label>Start (s)</Label>
              <Input
                type="number"
                step="0.1"
                min={0}
                max={totalDurationMs / 1000}
                value={(selected.startMs / 1000).toFixed(1)}
                onChange={(e) => {
                  const ms = Math.round(Number(e.target.value) * 1000);
                  const { prevEnd, nextStart } = neighborsFor(selected.localId, snippets);
                  const next = Math.max(prevEnd, Math.min(nextStart - selected.durationMs, ms));
                  updateSnippet(selected.localId, { startMs: next });
                }}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Duration (s)</Label>
              <Input
                type="number"
                step="0.1"
                min={MIN_SNIPPET_MS / 1000}
                value={(selected.durationMs / 1000).toFixed(1)}
                onChange={(e) => {
                  const ms = Math.round(Number(e.target.value) * 1000);
                  const { nextStart } = neighborsFor(selected.localId, snippets);
                  const maxDur = nextStart - selected.startMs;
                  const next = Math.max(MIN_SNIPPET_MS, Math.min(maxDur, ms));
                  updateSnippet(selected.localId, { durationMs: next });
                }}
                className="mt-1.5"
              />
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-6 text-center">
          <p className="text-[12px] text-muted-foreground italic font-display">
            Select a snippet on the timeline to edit it, or click the timeline to add one.
          </p>
        </Card>
      )}

      {/* Errors */}
      {error && (
        <Card className="p-4 mt-5 border-red-500/30 bg-red-500/5">
          <p className="text-[12px] text-red-400">{error}</p>
        </Card>
      )}

      {/* Result */}
      {result && (
        <Card className="p-5 mt-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase tracking-[0.22em] text-aurora-1">Rendered</div>
            <span className="text-[11px] text-muted-foreground/70">
              {result.format.toUpperCase()} · {result.chars} chars
              {result.durationMs ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          </div>
          <audio
            src={resultAudioSrc}
            controls
            autoPlay
            className="w-full h-10"
            style={{ colorScheme: 'dark' }}
          />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" asChild>
              <a href={resultAudioSrc} download={`${title || 'voiceover'}.${result.format}`}>
                Download
              </a>
            </Button>
            <Button onClick={() => navigate('/voiceovers')}>
              <Badge>✓</Badge> Save & exit
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
