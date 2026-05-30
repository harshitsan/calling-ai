import { ChevronDown, Loader2, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { languageLabel, MODELS, type TtsModel, VOICES, voiceById, type VoiceMeta } from '@/lib/voices';
import { cn } from '@/lib/utils';

interface Props {
  value: string;
  language: string;
  onChange: (voice: string, language: string) => void;
}

type GenderFilter = 'all' | 'female' | 'male';

const DEFAULT_LANG_FOR_MODEL: Record<TtsModel, string> = {
  '@cf/deepgram/aura-1': 'en-US',
  '@cf/deepgram/aura-2-en': 'en-US',
  '@cf/deepgram/aura-2-es': 'es',
  'google/gemini-3.1-flash-tts': 'multi',
};

export function VoicePicker({ value, language, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const current = voiceById(value);
  const [model, setModel] = useState<TtsModel>(current?.model ?? '@cf/deepgram/aura-2-en');
  const [gender, setGender] = useState<GenderFilter>('all');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (open && current?.model && current.model !== model) setModel(current.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const voicesForModel = useMemo(() => VOICES.filter((v) => v.model === model), [model]);
  const hasGenderData = voicesForModel.some((v) => v.gender);
  const filtered = useMemo(
    () =>
      voicesForModel.filter((v) => (gender === 'all' || !hasGenderData ? true : v.gender === gender)),
    [voicesForModel, gender, hasGenderData],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    },
    [],
  );

  async function preview(v: VoiceMeta, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (playingId === v.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    setPlayingId(v.id);
    try {
      const res = await fetch(
        `/api/tts?voice=${encodeURIComponent(v.id)}&text=${encodeURIComponent(`Hi, I'm ${v.label}. Pleasure to meet you.`)}`,
      );
      if (!res.ok) {
        setPlayingId(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      await audio.play();
    } catch {
      setPlayingId(null);
    }
  }

  function select(v: VoiceMeta) {
    const nextLang =
      v.languages.includes(language) ? language : (v.languages[0] ?? DEFAULT_LANG_FOR_MODEL[v.model] ?? 'en-US');
    onChange(v.id, nextLang);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group w-full text-left rounded-md bg-white/[0.03] border border-white/[0.07] px-4 py-3 transition-colors hover:bg-white/[0.05] hover:border-white/[0.12] flex items-center gap-4"
      >
        <div className="min-w-0 flex-1">
          {current ? (
            <>
              <div className="flex items-center gap-2">
                <span className="font-display text-xl tracking-tight text-foreground/95">{current.label}</span>
                {current.gender && <Badge>{current.gender}</Badge>}
                {current.hd && <Badge className="bg-aurora-1/15 text-aurora-1 border-aurora-1/20">HD</Badge>}
              </div>
              <div className="text-[12px] text-muted-foreground mt-0.5 truncate">
                {(current.description ? `${current.description} · ` : '') +
                  (MODELS.find((m) => m.id === current.model)?.label ?? current.model)}
              </div>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">Pick a voice</span>
          )}
        </div>
        <ChevronDown className="h-4 w-4 text-muted-foreground/70 shrink-0 group-hover:text-foreground/80 transition-colors" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-up"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-background/75 backdrop-blur-md" />
          <div
            className="relative glass rounded-2xl w-full max-w-[680px] max-h-[86vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="px-6 pt-6 pb-5 flex items-start justify-between gap-4 border-b border-white/[0.05]">
              <div>
                <h2 className="font-display text-3xl tracking-tight leading-none">
                  Choose a <span className="italic text-aurora">voice</span>
                </h2>
                <p className="text-[12px] text-muted-foreground mt-2">
                  {filtered.length} {filtered.length === 1 ? 'voice' : 'voices'} in this model
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-white/[0.06] text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            {/* Model cards */}
            <div className="px-6 py-4 border-b border-white/[0.05]">
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/75 mb-2.5">Model</div>
              <div className="grid grid-cols-2 gap-2">
                {MODELS.map((m) => {
                  const count = VOICES.filter((v) => v.model === m.id).length;
                  const isActive = model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setModel(m.id);
                        setGender('all');
                      }}
                      className={cn(
                        'text-left rounded-xl p-3.5 border transition-all',
                        isActive
                          ? 'bg-white/[0.07] border-white/[0.12] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.05)]'
                          : 'border-white/[0.05] bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/[0.09]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-display text-base text-foreground/95">{m.label}</div>
                        <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                          {count}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{m.description}</div>
                      {m.pricing && (
                        <div className="text-[10px] text-muted-foreground/60 mt-1.5">{m.pricing}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Gender chips (only when meaningful) */}
            {hasGenderData && (
              <div className="px-6 py-3 border-b border-white/[0.05]">
                <FilterRow
                  label="gender"
                  options={[
                    { id: 'all', label: 'All' },
                    { id: 'female', label: 'Female' },
                    { id: 'male', label: 'Male' },
                  ]}
                  value={gender}
                  onChange={(v) => setGender(v as GenderFilter)}
                />
              </div>
            )}

            {/* Voice list */}
            <div className="overflow-y-auto p-3 space-y-1.5">
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground italic font-display p-6 text-center">No voices.</p>
              )}
              {filtered.map((v) => {
                const isSelected = v.id === value;
                const isPlaying = playingId === v.id;
                return (
                  <div
                    key={v.id}
                    onClick={() => select(v)}
                    className={cn(
                      'group cursor-pointer rounded-xl p-3 flex items-center gap-3 transition-all',
                      isSelected
                        ? 'bg-white/[0.06] border border-white/[0.09] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.05)]'
                        : 'border border-transparent hover:bg-white/[0.03]',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-display text-lg tracking-tight text-foreground/95">{v.label}</span>
                        {v.gender && <Badge>{v.gender}</Badge>}
                        {v.hd && (
                          <Badge className="bg-aurora-1/15 text-aurora-1 border-aurora-1/20">HD</Badge>
                        )}
                        {isSelected && (
                          <span className="text-[10px] uppercase tracking-[0.18em] text-aurora-1">selected</span>
                        )}
                      </div>
                      <div className="text-[12px] text-muted-foreground mt-0.5">
                        {v.description ? `${v.description} · ` : ''}
                        {v.languages.map((l) => languageLabel(l)).join(' · ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => preview(v, e)}
                      className="shrink-0 h-9 w-9 rounded-full border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/[0.14] flex items-center justify-center text-foreground/85 transition-colors"
                      aria-label={`Preview ${v.label}`}
                    >
                      {isPlaying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface ChipOption {
  id: string;
  label: string;
}
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ChipOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-12 text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">{label}</span>
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
