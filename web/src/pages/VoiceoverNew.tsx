import { ArrowLeft, Loader2, Pause as PauseIcon, Play, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

const genderGlyph = (g?: 'female' | 'male') => (g === 'female' ? '♀' : g === 'male' ? '♂' : '');

export function VoiceoverNew() {
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<string>('en-US');
  const [voiceId, setVoiceId] = useState<string>('');
  const [script, setScript] = useState('');

  const [voicesMeta, setVoicesMeta] = useState<VoicesResponse | null>(null);
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male'>('all');
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResponse['voiceover'] | null>(null);

  const scriptRef = useRef<HTMLTextAreaElement | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setVoicesMeta(null);
    setVoiceId('');
    setGenderFilter('all');
    api<VoicesResponse>(`/api/voiceovers/voices?lang=${encodeURIComponent(language)}`)
      .then((r) => {
        setVoicesMeta(r);
        if (r.voices[0]) setVoiceId(r.voices[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, [language]);

  useEffect(() => () => audioPreviewRef.current?.pause(), []);

  const hasGender = useMemo(
    () => (voicesMeta?.voices ?? []).some((v) => v.gender),
    [voicesMeta],
  );
  const filteredVoices = useMemo(() => {
    if (!voicesMeta) return [];
    if (!hasGender || genderFilter === 'all') return voicesMeta.voices;
    return voicesMeta.voices.filter((v) => v.gender === genderFilter);
  }, [voicesMeta, genderFilter, hasGender]);

  const selectedVoice = voicesMeta?.voices.find((v) => v.id === voiceId);
  const chars = script.length;
  const overLimit = chars > MAX_CHARS;

  function insertPauseToken(kind: 'short' | 'medium' | 'long') {
    const ta = scriptRef.current;
    const token = `[pause:${kind}]`;
    if (!ta) { setScript((s) => s + token); return; }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = script.slice(0, start) + token + script.slice(end);
    setScript(next);
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + token.length;
      ta.setSelectionRange(caret, caret);
    });
  }

  async function previewVoice(v: VoiceItem) {
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

  async function generate() {
    if (!voiceId || !script.trim() || overLimit) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<CreateResponse>('/api/voiceovers', {
        method: 'POST',
        body: JSON.stringify({ title, scriptText: script, voiceId, language }),
      });
      setResult(r.voiceover);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  const resultAudioSrc = useMemo(() => {
    if (!result) return '';
    const t = getToken();
    return t ? `${result.audioUrl}?_t=${encodeURIComponent(t)}` : result.audioUrl;
  }, [result]);

  return (
    <div className="fade-up max-w-[860px]">
      <Link
        to="/voiceovers"
        className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Voiceovers
      </Link>

      <header className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          New Voiceover
        </div>
        <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
          Render a <span className="italic text-aurora">voice</span>.
        </h1>
      </header>

      <Card className="p-6 space-y-6">
        {/* Title */}
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Product launch — hero clip"
            className="mt-1.5"
          />
        </div>

        {/* Language + voice */}
        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-5">
          <div>
            <Label htmlFor="lang">Language</Label>
            <Select
              id="lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="mt-1.5"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </Select>
            {voicesMeta && (
              <p className="mt-2 text-[11px] text-muted-foreground/75 leading-relaxed">
                {voicesMeta.modelLabel}
              </p>
            )}
          </div>

          <div>
            <Label>Voice</Label>
            {!voicesMeta ? (
              <div className="mt-1.5 h-[42px] rounded-md bg-white/[0.03] border border-white/[0.07] flex items-center px-3 text-[12px] text-muted-foreground">
                Loading voices…
              </div>
            ) : (
              <>
                {hasGender && (
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
                    value={voiceId || filteredVoices[0]?.id || ''}
                    onChange={(e) => setVoiceId(e.target.value)}
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
                    onClick={() => selectedVoice && previewVoice(selectedVoice)}
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
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Script + pause inserts */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <Label htmlFor="script">Script</Label>
            <span
              className={cn(
                'text-[11px]',
                overLimit ? 'text-red-400' : 'text-muted-foreground/60',
              )}
            >
              {chars} / {MAX_CHARS} chars
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
                onClick={() => insertPauseToken(k)}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground/95 hover:bg-white/[0.05] transition-colors"
                title={`Insert a ${k} pause at the cursor`}
              >
                <PauseIcon className="h-3 w-3" /> {k}
              </button>
            ))}
            <span className="ml-auto text-[10px] text-muted-foreground/50 italic">
              Tokens stay visible; we expand them at render.
            </span>
          </div>
          <Textarea
            id="script"
            ref={scriptRef}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste your script. Use the buttons above to drop a [pause:short|medium|long] token at the cursor."
            rows={9}
            className={cn(
              'font-serif leading-relaxed',
              overLimit && 'border-red-500/40 focus-visible:ring-red-500/40',
            )}
          />
        </div>

        {error && (
          <p className="text-[12px] text-red-400/90 bg-red-500/8 border border-red-500/15 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.05]">
          <Button variant="ghost" asChild>
            <Link to="/voiceovers">Cancel</Link>
          </Button>
          <Button
            onClick={generate}
            disabled={generating || !voiceId || !script.trim() || overLimit}
          >
            {generating ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Rendering…</>
            ) : (
              <><Sparkles className="h-4 w-4" /> {result ? 'Regenerate' : 'Generate'}</>
            )}
          </Button>
        </div>
      </Card>

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
            <Button onClick={() => navigate('/voiceovers')}>Save & exit</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
