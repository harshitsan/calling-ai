// Voiceovers — timeline-based async TTS render-and-store.
// Disable: flip VOICEOVERS_ENABLED to false here AND in web/src/lib/features.ts.
//
// Architecture
//   POST /api/voiceovers     → create project + snippets, render mixed WAV
//   GET  /api/voiceovers     → list projects
//   GET  /api/voiceovers/:id → project + snippet list
//   GET  /api/voiceovers/:id/audio → stream the mixed WAV
//   DEL  /api/voiceovers/:id → delete project + snippets + R2 object
//   GET  /api/voiceovers/voices?lang=… → voices for the language-routed provider
//
// Render pipeline (server, in-worker, ≤5 minute projects):
//   1. Synthesize each snippet to raw 16-bit PCM at MIX_SAMPLE_RATE (24 kHz).
//   2. Resample to fit snippet.durationMs (linear interp — pitch shifts at
//      extreme ratios; transparent within ±20%; future v2 = WASM SoundTouch).
//   3. Allocate silence buffer of project totalDurationMs.
//   4. Copy each resampled snippet into the buffer at snippet.startMs.
//   5. Wrap as WAV and store in R2.
//
// Pillars unchanged: quality > cost > speed; en→Aura-2 EN, es→Aura-2 ES,
// else→Gemini Flash multilingual.

import { synthesizePcm, wrapPcmAsWav } from './adapters';
import { authenticate } from './api';
import { err, json, now, uuid } from './util';

export const VOICEOVERS_ENABLED = true;

const MAX_CHARS_PER_SNIPPET = 5000;
const MAX_SNIPPETS = 30;
const MIN_TOTAL_DURATION_MS = 1000;
const MAX_TOTAL_DURATION_MS = 5 * 60 * 1000;
const MIN_SNIPPET_DURATION_MS = 500;
const MIX_SAMPLE_RATE = 24000;

export type RoutedModel =
  | '@cf/deepgram/aura-2-en'
  | '@cf/deepgram/aura-2-es'
  | 'google/gemini-3.1-flash-tts';

export interface Provider {
  model: RoutedModel;
  voicePrefix: 'aura2en' | 'aura2es' | 'gemini';
  modelLabel: string;
  format: 'mp3' | 'wav';
  pricePerMinUsd: number;
}

export type Speed = 'slow' | 'normal' | 'fast';

export function pickProvider(language: string): Provider {
  const code = language.toLowerCase().split('-')[0];
  if (code === 'en') {
    return {
      model: '@cf/deepgram/aura-2-en',
      voicePrefix: 'aura2en',
      modelLabel: 'Aura-2 HD · English',
      format: 'mp3',
      pricePerMinUsd: 0.022,
    };
  }
  if (code === 'es') {
    return {
      model: '@cf/deepgram/aura-2-es',
      voicePrefix: 'aura2es',
      modelLabel: 'Aura-2 HD · Spanish',
      format: 'mp3',
      pricePerMinUsd: 0.022,
    };
  }
  return {
    model: 'google/gemini-3.1-flash-tts',
    voicePrefix: 'gemini',
    modelLabel: 'Gemini Flash · Multilingual',
    format: 'wav',
    pricePerMinUsd: 0,
  };
}

/**
 * Expand author-friendly tokens into TTS-ready text.
 * `[pause:short|medium|long]` → punctuation; for Gemini, speed cues become
 * natural-language pacing directives. Aura has no speed knob.
 */
export function expandScript(text: string, speed: Speed, provider: Provider): string {
  const expanded = text
    .replace(/\[pause:short\]/gi, ', ')
    .replace(/\[pause:medium\]/gi, '. ')
    .replace(/\[pause:long\]/gi, '... ')
    .replace(/\[pause:\d+(?:\.\d+)?s\]/gi, '... ')  // legacy fallback if used outside the splice path
    .replace(/\[pause:\d+ms\]/gi, '... ')
    .trim();
  if (speed === 'normal' || provider.voicePrefix !== 'gemini') return expanded;
  const directive =
    speed === 'slow'
      ? 'Speak at a slow, measured pace.'
      : 'Speak at a brisk, energetic pace.';
  return `${directive} ${expanded}`;
}

/**
 * Parse a script into alternating text and silence segments.
 * Recognized pause tokens:
 *   [pause:1.5s]   precise seconds
 *   [pause:750ms]  precise milliseconds
 *   [pause:short]  legacy preset (500 ms)
 *   [pause:medium] legacy preset (1000 ms)
 *   [pause:long]   legacy preset (2000 ms)
 *
 * Splice mode renders silence for exact-duration control; the legacy
 * presets keep working with sensible defaults.
 */
export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'silence'; durationMs: number };

export function parseSegments(text: string): Segment[] {
  const re = /\[pause:(?:(\d+(?:\.\d+)?)s|(\d+)ms|(short|medium|long))\]/gi;
  const out: Segment[] = [];
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) {
      const before = text.slice(lastEnd, m.index);
      if (before.trim() !== '') out.push({ kind: 'text', value: before });
    }
    let durationMs = 0;
    if (m[1]) durationMs = Math.round(parseFloat(m[1]) * 1000);
    else if (m[2]) durationMs = parseInt(m[2], 10);
    else if (m[3]) {
      const k = m[3].toLowerCase();
      durationMs = k === 'short' ? 500 : k === 'medium' ? 1000 : 2000;
    }
    // Clamp 50 ms .. 10 s so a typo can't allocate huge buffers.
    durationMs = Math.max(50, Math.min(10_000, durationMs));
    out.push({ kind: 'silence', durationMs });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    const tail = text.slice(lastEnd);
    if (tail.trim() !== '') out.push({ kind: 'text', value: tail });
  }
  return out;
}

// ----- Voice catalogue (server-side source of truth) -----
const AURA2_EN_FEMALE = [
  'amalthea','andromeda','asteria','athena','aurora','callista','cora','cordelia','delia',
  'electra','harmonia','helena','hera','iris','juno','luna','minerva','ophelia','pandora',
  'phoebe','thalia','theia','vesta',
];
const AURA2_EN_MALE = [
  'apollo','arcas','aries','atlas','draco','hermes','hyperion','janus','jupiter','mars',
  'neptune','odysseus','orion','orpheus','pluto','saturn','zeus',
];
const AURA2_ES_FEMALE = ['carina', 'celeste', 'diana', 'selena', 'estrella'];
const AURA2_ES_MALE = ['sirio', 'nestor', 'alvaro', 'aquila', 'javier'];
const GEMINI_NAMES = [
  'Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe',
  'Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi',
  'Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi',
  'Vindemiatrix','Sadachbia','Sadaltager','Sulafat',
];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

interface VoiceMeta { id: string; label: string; gender?: 'female' | 'male' }
export function voicesForProvider(p: Provider): VoiceMeta[] {
  if (p.voicePrefix === 'aura2en') {
    return [
      ...AURA2_EN_FEMALE.map((s) => ({ id: `aura2en:${s}`, label: cap(s), gender: 'female' as const })),
      ...AURA2_EN_MALE.map((s) => ({ id: `aura2en:${s}`, label: cap(s), gender: 'male' as const })),
    ];
  }
  if (p.voicePrefix === 'aura2es') {
    return [
      ...AURA2_ES_FEMALE.map((s) => ({ id: `aura2es:${s}`, label: cap(s), gender: 'female' as const })),
      ...AURA2_ES_MALE.map((s) => ({ id: `aura2es:${s}`, label: cap(s), gender: 'male' as const })),
    ];
  }
  return GEMINI_NAMES.map((n) => ({ id: `gemini:${n}`, label: n }));
}

// ----- DSP helpers -----

/**
 * Linear-interpolation resampler. Used for two distinct jobs:
 *   - true sample-rate conversion (source rate → 24 kHz)
 *   - duration-fit by treating srcRate/dstRate as a virtual playback ratio
 * Pitch shifts when the ratio ≠ 1. Acceptable for ±20% time-fit. v2 = SoundTouch.
 */
export function resamplePcm(input: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const dstLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = Math.round(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return out;
}

/**
 * Stretch/compress PCM so its play length matches targetMs at sampleRate.
 * Implementation: nearest-integer ratio resample. ±20% sounds natural; beyond
 * that the pitch shifts noticeably.
 */
export function fitToDuration(pcm: Int16Array, sampleRate: number, targetMs: number): Int16Array {
  const targetSamples = Math.floor((targetMs / 1000) * sampleRate);
  if (targetSamples <= 0 || pcm.length === 0) return new Int16Array(targetSamples);
  if (targetSamples === pcm.length) return pcm;
  // virtual src rate so resampler emits exactly targetSamples samples
  const virtualSrcRate = sampleRate * (pcm.length / targetSamples);
  return resamplePcm(pcm, virtualSrcRate, sampleRate);
}

export interface SnippetRender {
  pcm: Int16Array;
  sampleRate: number;
  startMs: number;
  durationMs: number;
}

/**
 * Mix N already-PCM snippets into one buffer.
 * Each snippet is fitted to its slot, then copied at its startMs offset.
 * Gaps stay zero-filled (silence).
 */
export function mixSnippetsToPcm(
  snippets: SnippetRender[],
  totalMs: number,
  outRate: number,
): Int16Array {
  const totalSamples = Math.floor((totalMs / 1000) * outRate);
  const out = new Int16Array(totalSamples);
  for (const s of snippets) {
    // Normalize sample rate first (so durations are measured in the same units),
    // then stretch to fit the slot.
    const rateAligned = s.sampleRate === outRate ? s.pcm : resamplePcm(s.pcm, s.sampleRate, outRate);
    const fitted = fitToDuration(rateAligned, outRate, s.durationMs);
    const startSample = Math.floor((s.startMs / 1000) * outRate);
    const writeLen = Math.min(fitted.length, totalSamples - startSample);
    if (writeLen > 0) out.set(fitted.subarray(0, writeLen), startSample);
  }
  return out;
}

// ----- DB rows -----
interface JobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string | null;
  script_text: string;
  voice_id: string;
  model: string;
  language: string;
  format: string;
  chars: number;
  duration_ms: number | null;
  cost_usd_micro: number | null;
  r2_key: string;
  status: string;
  error: string | null;
  created_at: number;
  rendered_at: number | null;
  total_duration_ms: number | null;
}
interface SnippetRow {
  id: string;
  job_id: string;
  position: number;
  start_ms: number;
  duration_ms: number;
  script_text: string;
  voice_id: string;
  model: string;
  language: string;
  speed: string;
  created_at: number;
}

function snippetToJson(r: SnippetRow): Record<string, unknown> {
  return {
    id: r.id,
    position: r.position,
    startMs: r.start_ms,
    durationMs: r.duration_ms,
    scriptText: r.script_text,
    voiceId: r.voice_id,
    model: r.model,
    language: r.language,
    speed: r.speed,
  };
}

function rowToJson(r: JobRow, snippets: SnippetRow[] = []): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title ?? '',
    totalDurationMs: r.total_duration_ms ?? r.duration_ms ?? null,
    format: r.format,
    chars: r.chars,
    durationMs: r.duration_ms,
    costUsdMicro: r.cost_usd_micro,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    renderedAt: r.rendered_at,
    audioUrl: `/api/voiceovers/${r.id}/audio`,
    snippets: snippets.map(snippetToJson),
  };
}

interface ClientSnippet {
  startMs?: unknown;
  durationMs?: unknown;
  scriptText?: unknown;
  voiceId?: unknown;
  language?: unknown;
  speed?: unknown;
}

interface CreateBody {
  title?: unknown;
  totalDurationMs?: unknown;
  snippets?: unknown;
  // Simple single-script mode (no timeline) — preserved as the primary UX:
  scriptText?: unknown;
  voiceId?: unknown;
  language?: unknown;
}

interface ValidSnippet {
  startMs: number;
  durationMs: number;
  scriptText: string;
  voiceId: string;
  language: string;
  speed: Speed;
}

function validateSnippets(
  raw: unknown,
  totalDurationMs: number,
): { ok: true; snippets: ValidSnippet[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'snippets must be an array' };
  if (raw.length === 0) return { ok: false, error: 'project must contain at least one snippet' };
  if (raw.length > MAX_SNIPPETS) return { ok: false, error: `too many snippets (max ${MAX_SNIPPETS})` };

  const out: ValidSnippet[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as ClientSnippet;
    const startMs = Number(s.startMs);
    const durationMs = Number(s.durationMs);
    const scriptText = typeof s.scriptText === 'string' ? s.scriptText.trim() : '';
    const voiceId = typeof s.voiceId === 'string' ? s.voiceId : '';
    const language = typeof s.language === 'string' ? s.language : 'en-US';
    const speed: Speed = s.speed === 'slow' || s.speed === 'fast' ? s.speed : 'normal';

    if (!Number.isFinite(startMs) || startMs < 0) return { ok: false, error: `snippet ${i}: bad startMs` };
    if (!Number.isFinite(durationMs) || durationMs < MIN_SNIPPET_DURATION_MS) {
      return { ok: false, error: `snippet ${i}: durationMs must be ≥ ${MIN_SNIPPET_DURATION_MS}` };
    }
    if (startMs + durationMs > totalDurationMs) {
      return { ok: false, error: `snippet ${i}: extends past project end` };
    }
    if (!scriptText) return { ok: false, error: `snippet ${i}: scriptText required` };
    if (scriptText.length > MAX_CHARS_PER_SNIPPET) {
      return { ok: false, error: `snippet ${i}: script exceeds ${MAX_CHARS_PER_SNIPPET} chars` };
    }
    if (!voiceId) return { ok: false, error: `snippet ${i}: voiceId required` };

    // voice ↔ language consistency
    const provider = pickProvider(language);
    const valid = new Set(voicesForProvider(provider).map((v) => v.id));
    if (!valid.has(voiceId)) {
      return { ok: false, error: `snippet ${i}: voice "${voiceId}" not valid for language "${language}"` };
    }
    out.push({ startMs, durationMs, scriptText, voiceId, language, speed });
  }
  // Sort + overlap check
  out.sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.startMs < out[i - 1]!.startMs + out[i - 1]!.durationMs) {
      return { ok: false, error: `snippets ${i - 1} and ${i} overlap` };
    }
  }
  return { ok: true, snippets: out };
}

export async function handleVoiceoverApi(
  request: Request,
  env: Env,
  authResult: { tenantId: string; userId?: string } | null,
): Promise<Response | null> {
  if (!VOICEOVERS_ENABLED) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith('/api/voiceovers')) return null;
  if (!authResult) return err(401, 'unauthorized');
  const auth = authResult;

  // GET /api/voiceovers/voices?lang=xx-XX
  if (path === '/api/voiceovers/voices' && method === 'GET') {
    const lang = url.searchParams.get('lang') ?? 'en-US';
    const provider = pickProvider(lang);
    return json({
      model: provider.model,
      modelLabel: provider.modelLabel,
      format: provider.format,
      pricePerMinUsd: provider.pricePerMinUsd,
      voices: voicesForProvider(provider),
    });
  }

  // GET /api/voiceovers — list
  if (path === '/api/voiceovers' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM voiceover_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200',
    )
      .bind(auth.tenantId)
      .all<JobRow>();
    // Snippet counts in a single follow-up query.
    const counts = new Map<string, number>();
    if (results.length > 0) {
      const ids = results.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const { results: cs } = await env.DB.prepare(
        `SELECT job_id, COUNT(*) as n FROM voiceover_snippets WHERE job_id IN (${placeholders}) GROUP BY job_id`,
      )
        .bind(...ids)
        .all<{ job_id: string; n: number }>();
      for (const c of cs) counts.set(c.job_id, c.n);
    }
    return json({
      voiceovers: results.map((r) => ({
        ...rowToJson(r),
        snippetCount: counts.get(r.id) ?? 0,
      })),
    });
  }

  // POST /api/voiceovers — render
  if (path === '/api/voiceovers' && method === 'POST') {
    const body = (await request.json().catch(() => null)) as CreateBody | null;
    if (!body) return err(400, 'invalid body');
    if (!auth.userId) return err(403, 'user context required');

    const title = typeof body.title === 'string' ? body.title.trim() : '';

    // Simple single-script mode: body has scriptText + voiceId + language, no snippets.
    if (typeof body.scriptText === 'string' && typeof body.voiceId === 'string') {
      const scriptText = body.scriptText.trim();
      const voiceId = body.voiceId;
      const language = typeof body.language === 'string' ? body.language : 'en-US';
      if (!scriptText) return err(400, 'scriptText is required');
      if (scriptText.length > MAX_CHARS_PER_SNIPPET) {
        return err(400, `script exceeds ${MAX_CHARS_PER_SNIPPET} chars`);
      }
      const provider = pickProvider(language);
      const valid = new Set(voicesForProvider(provider).map((v) => v.id));
      if (!valid.has(voiceId)) {
        return err(400, `voice "${voiceId}" is not valid for language "${language}"`);
      }

      const segments = parseSegments(scriptText);
      const hasSilenceSplice = segments.some((s) => s.kind === 'silence');
      const id = uuid();
      const format: 'mp3' | 'wav' = hasSilenceSplice ? 'wav' : provider.format;
      const r2Key = `voiceovers/${auth.tenantId}/${id}.${format}`;
      const createdAt = now();
      const env2 = env as unknown as { GOOGLE_AI_API_KEY?: string };

      try {
        let bytes: Uint8Array;
        let contentType: string;
        let renderedMs: number;

        if (!hasSilenceSplice) {
          // Fast path: no precise pauses requested. Synthesize once, save native format.
          const { synthesizeTts } = await import('./adapters');
          const out = await synthesizeTts({
            ai: env.AI,
            googleApiKey: env2.GOOGLE_AI_API_KEY,
            voiceId,
            text: scriptText,
          });
          bytes = out.bytes;
          contentType = out.contentType;
          const cps = provider.voicePrefix === 'gemini' ? 12 : 15;
          renderedMs = Math.round((scriptText.length / cps) * 1000);
        } else {
          // Splice path: synthesize each text segment to PCM, insert exact-duration
          // silence between segments, concatenate, wrap as WAV. Output is always WAV
          // because we need to work in PCM to splice precisely.
          const parts: Int16Array[] = [];
          let silenceTotalMs = 0;
          let speechTotalMs = 0;
          for (const seg of segments) {
            if (seg.kind === 'text') {
              const { pcm, sampleRate } = await synthesizePcm({
                ai: env.AI,
                googleApiKey: env2.GOOGLE_AI_API_KEY,
                voiceId,
                text: seg.value,
              });
              const aligned = sampleRate === MIX_SAMPLE_RATE
                ? pcm
                : resamplePcm(pcm, sampleRate, MIX_SAMPLE_RATE);
              parts.push(aligned);
              speechTotalMs += Math.round((aligned.length / MIX_SAMPLE_RATE) * 1000);
            } else {
              const samples = Math.round((seg.durationMs / 1000) * MIX_SAMPLE_RATE);
              parts.push(new Int16Array(samples));
              silenceTotalMs += seg.durationMs;
            }
          }
          const total = parts.reduce((n, p) => n + p.length, 0);
          const merged = new Int16Array(total);
          let off = 0;
          for (const p of parts) { merged.set(p, off); off += p.length; }
          const pcmBytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
          bytes = wrapPcmAsWav(pcmBytes, MIX_SAMPLE_RATE, 1, 16);
          contentType = 'audio/wav';
          renderedMs = silenceTotalMs + speechTotalMs;
        }

        await env.RECORDINGS.put(r2Key, bytes, {
          httpMetadata: { contentType, cacheControl: 'private, max-age=86400' },
        });

        const costUsdMicro = Math.round((renderedMs / 60_000) * provider.pricePerMinUsd * 1_000_000);
        await env.DB.prepare(
          `INSERT INTO voiceover_jobs
           (id, tenant_id, user_id, title, script_text, voice_id, model, language, format,
            chars, duration_ms, cost_usd_micro, r2_key, status, error, created_at, rendered_at, total_duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, NULL)`,
        )
          .bind(
            id, auth.tenantId, auth.userId, title || null, scriptText, voiceId, provider.model,
            language, format, scriptText.length, renderedMs, costUsdMicro, r2Key,
            createdAt, now(),
          )
          .run();
        const row = await env.DB.prepare('SELECT * FROM voiceover_jobs WHERE id = ?')
          .bind(id).first<JobRow>();
        return json({ voiceover: rowToJson(row!) }, { status: 201 });
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        return err(500, msg || 'render failed');
      }
    }

    // Timeline mode (legacy): body has totalDurationMs + snippets array.
    const totalDurationMs = Number(body.totalDurationMs);
    if (!Number.isFinite(totalDurationMs) || totalDurationMs < MIN_TOTAL_DURATION_MS ||
        totalDurationMs > MAX_TOTAL_DURATION_MS) {
      return err(400, `totalDurationMs must be ${MIN_TOTAL_DURATION_MS}–${MAX_TOTAL_DURATION_MS}`);
    }
    const validated = validateSnippets(body.snippets, totalDurationMs);
    if (!validated.ok) return err(400, validated.error);
    const snippets = validated.snippets;

    const id = uuid();
    const r2Key = `voiceovers/${auth.tenantId}/${id}.wav`;
    const createdAt = now();
    const env2 = env as unknown as { GOOGLE_AI_API_KEY?: string };

    // Insert the job row up front as "rendering" so the UI can show progress
    // (and a failure row gets cleaned up below if mixing fails).
    const totalChars = snippets.reduce((n, s) => n + s.scriptText.length, 0);
    await env.DB.prepare(
      `INSERT INTO voiceover_jobs
       (id, tenant_id, user_id, title, script_text, voice_id, model, language, format,
        chars, duration_ms, cost_usd_micro, r2_key, status, error, created_at, rendered_at, total_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wav', ?, NULL, NULL, ?, 'rendering', NULL, ?, NULL, ?)`,
    )
      .bind(
        id, auth.tenantId, auth.userId, title || null,
        // legacy single-script fields snapshot the first snippet for back-compat
        snippets[0]!.scriptText, snippets[0]!.voiceId, pickProvider(snippets[0]!.language).model,
        snippets[0]!.language,
        totalChars, r2Key, createdAt, totalDurationMs,
      )
      .run();

    try {
      // Render every snippet's TTS in parallel.
      const renders = await Promise.all(
        snippets.map(async (s) => {
          const provider = pickProvider(s.language);
          const text = expandScript(s.scriptText, s.speed, provider);
          const { pcm, sampleRate } = await synthesizePcm({
            ai: env.AI,
            googleApiKey: env2.GOOGLE_AI_API_KEY,
            voiceId: s.voiceId,
            text,
          });
          return { pcm, sampleRate, startMs: s.startMs, durationMs: s.durationMs };
        }),
      );

      const mixed = mixSnippetsToPcm(renders, totalDurationMs, MIX_SAMPLE_RATE);
      const pcmBytes = new Uint8Array(mixed.buffer, mixed.byteOffset, mixed.byteLength);
      const wav = wrapPcmAsWav(pcmBytes, MIX_SAMPLE_RATE, 1, 16);

      await env.RECORDINGS.put(r2Key, wav, {
        httpMetadata: { contentType: 'audio/wav', cacheControl: 'private, max-age=86400' },
      });

      // Persist snippet rows + flip job to ready, in one batch.
      const stmts = [
        env.DB.prepare(
          `UPDATE voiceover_jobs SET status='ready', duration_ms=?, rendered_at=? WHERE id=?`,
        ).bind(totalDurationMs, now(), id),
        ...snippets.map((s, idx) =>
          env.DB.prepare(
            `INSERT INTO voiceover_snippets
             (id, job_id, position, start_ms, duration_ms, script_text, voice_id, model, language, speed, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            uuid(), id, idx, s.startMs, s.durationMs, s.scriptText, s.voiceId,
            pickProvider(s.language).model, s.language, s.speed, createdAt,
          ),
        ),
      ];
      await env.DB.batch(stmts);

      const jobRow = await env.DB.prepare('SELECT * FROM voiceover_jobs WHERE id = ?')
        .bind(id).first<JobRow>();
      const { results: snipRows } = await env.DB.prepare(
        'SELECT * FROM voiceover_snippets WHERE job_id = ? ORDER BY position ASC',
      ).bind(id).all<SnippetRow>();
      return json({ voiceover: rowToJson(jobRow!, snipRows) }, { status: 201 });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await env.DB.prepare(
        `UPDATE voiceover_jobs SET status='failed', error=? WHERE id=?`,
      ).bind(msg, id).run();
      return err(500, msg || 'render failed');
    }
  }

  // GET /api/voiceovers/:id/audio
  const audioMatch = path.match(/^\/api\/voiceovers\/([a-f0-9-]+)\/audio$/);
  if (audioMatch && method === 'GET') {
    const id = audioMatch[1]!;
    const row = await env.DB.prepare(
      'SELECT r2_key, format, status FROM voiceover_jobs WHERE id = ? AND tenant_id = ?',
    )
      .bind(id, auth.tenantId)
      .first<{ r2_key: string; format: string; status: string }>();
    if (!row) return err(404, 'voiceover not found');
    if (row.status !== 'ready') return err(409, `voiceover is ${row.status}`);
    const obj = await env.RECORDINGS.get(row.r2_key);
    if (!obj) return err(404, 'audio missing');
    const contentType = row.format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? contentType,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  // GET /api/voiceovers/:id
  const oneMatch = path.match(/^\/api\/voiceovers\/([a-f0-9-]+)$/);
  if (oneMatch && method === 'GET') {
    const id = oneMatch[1]!;
    const row = await env.DB.prepare('SELECT * FROM voiceover_jobs WHERE id = ? AND tenant_id = ?')
      .bind(id, auth.tenantId)
      .first<JobRow>();
    if (!row) return err(404, 'voiceover not found');
    const { results: snips } = await env.DB.prepare(
      'SELECT * FROM voiceover_snippets WHERE job_id = ? ORDER BY position ASC',
    ).bind(id).all<SnippetRow>();
    return json({ voiceover: rowToJson(row, snips) });
  }

  // DELETE /api/voiceovers/:id
  if (oneMatch && method === 'DELETE') {
    const id = oneMatch[1]!;
    const row = await env.DB.prepare(
      'SELECT r2_key FROM voiceover_jobs WHERE id = ? AND tenant_id = ?',
    )
      .bind(id, auth.tenantId)
      .first<{ r2_key: string }>();
    if (!row) return err(404, 'voiceover not found');
    await env.RECORDINGS.delete(row.r2_key).catch(() => {});
    await env.DB.batch([
      env.DB.prepare('DELETE FROM voiceover_snippets WHERE job_id = ?').bind(id),
      env.DB.prepare('DELETE FROM voiceover_jobs WHERE id = ? AND tenant_id = ?').bind(id, auth.tenantId),
    ]);
    return json({ ok: true });
  }

  return err(404, 'not found');
}

export { authenticate };
