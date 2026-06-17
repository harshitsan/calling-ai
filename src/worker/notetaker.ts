// Notetaker — upload an audio file, get back a transcript + structured
// meeting notes. Disable: flip NOTETAKER_ENABLED here + in
// web/src/lib/features.ts.
//
// Pipeline:
//   POST /api/notetaker (multipart)
//     ↓ store audio bytes → R2  (key: notetaker/<tenant>/<id>.<ext>)
//     ↓ insert row status='queued'
//     ↓ ctx.waitUntil(processJob(...))  — async, no DO
//     ↑ return 202 with the job row
//
// processJob:
//   1. Read audio from R2
//   2. Workers AI @cf/openai/whisper-large-v3-turbo → transcript + word timing
//   3. status='summarizing'
//   4. LLM pass (OpenAI Responses if key set, else Llama 3.1 8B) extracts
//      {summary, actionItems, keyTopics, sentiment, decisions, speakers}
//   5. status='ready'

import { OpenAiLlm, WorkersAiLlm } from './adapters';
import { bytesToBase64 } from './codecs';
import type { LlmPort } from '../engine/ports';
import type { Message } from '../engine/types';
import { err, json, now, uuid } from './util';

export const NOTETAKER_ENABLED = true;

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB hard cap — Whisper limits may be lower
const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/ogg', 'audio/flac', 'audio/aac',
  // some browsers/upload paths send octet-stream
  'application/octet-stream',
]);

interface JobRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string | null;
  audio_r2_key: string;
  audio_size_bytes: number;
  audio_duration_sec: number | null;
  mime_type: string;
  status: 'queued' | 'transcribing' | 'summarizing' | 'ready' | 'failed';
  error: string | null;
  transcript_text: string | null;
  transcript_words: string | null;
  notes_json: string | null;
  chars: number | null;
  cost_usd_micro: number | null;
  created_at: number;
  transcribed_at: number | null;
  completed_at: number | null;
  webhook_url?: string | null;
  webhook_status?: string | null;
  webhook_attempts?: number | null;
  participants_json?: string | null;
  speaker_timeline_json?: string | null;
}

export interface NotetakerQueueMessage {
  kind: 'process' | 'webhook';
  jobId: string;
  tenantId: string;
}

/** Queue producer binding — typed loosely until `wrangler types` regen. */
function getQueue(env: Env): { send(msg: NotetakerQueueMessage): Promise<unknown> } {
  return (env as unknown as { NOTETAKER_QUEUE: { send(msg: NotetakerQueueMessage): Promise<unknown> } })
    .NOTETAKER_QUEUE;
}

interface NotesShape {
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  decisions: string[];
  speakers: string[];
  speakerMap: Record<string, string | null>;
}

function rowToJson(r: JobRow): Record<string, unknown> {
  let words: unknown[] = [];
  try { const v = JSON.parse(r.transcript_words ?? '[]'); if (Array.isArray(v)) words = v; } catch { /* ignore */ }
  let notes: unknown = null;
  try { notes = r.notes_json ? JSON.parse(r.notes_json) : null; } catch { notes = null; }
  let participants: unknown[] = [];
  try { const v = JSON.parse(r.participants_json ?? '[]'); if (Array.isArray(v)) participants = v; } catch { /* ignore */ }
  return {
    id: r.id,
    title: r.title ?? '',
    audioUrl: `/api/notetaker/${r.id}/audio`,
    audioSizeBytes: r.audio_size_bytes,
    audioDurationSec: r.audio_duration_sec,
    mimeType: r.mime_type,
    status: r.status,
    error: r.error,
    transcriptText: r.transcript_text,
    transcriptWords: words,
    notes,
    participants,
    chars: r.chars,
    costUsdMicro: r.cost_usd_micro,
    createdAt: r.created_at,
    transcribedAt: r.transcribed_at,
    completedAt: r.completed_at,
  };
}

function extFromMime(mime: string): string {
  if (mime.includes('mp3') || mime === 'audio/mpeg') return 'mp3';
  if (mime.includes('m4a') || mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('flac')) return 'flac';
  return 'bin';
}

const NOTES_PROMPT = `You extract structured meeting notes from transcripts.

The transcript MAY contain speaker labels like [Speaker 0], [Speaker 1], etc.
Your job for the "speakers" field is to map each speaker NUMBER to a real
person's NAME whenever the transcript reveals it.

How to find names in the transcript:
1. Direct introduction: "I'm Alex", "My name is Mira", "This is Sadhguru"
2. Being addressed: "Welcome back Sadhguru", "All right Alex", "Thanks Mira"
3. Being referred to in third person: "Sadhguru, what do you think?", "As Alex said"
4. Signature phrases / known content patterns ONLY IF very strong (e.g.
   someone explicitly says they host a specific show)

Return ONLY a single JSON object with these exact keys:
{
  "summary": "2-3 sentences of what this call/meeting was about",
  "actionItems": ["concrete next-step #1", "..."],
  "keyTopics": ["topic #1", "..."],
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "decisions": ["decision reached on..."],
  "speakers": ["Sadhguru (Speaker 0)", "Speaker 1", "Ian Somerhalder (Speaker 2)"],
  "speakerMap": { "0": "Sadhguru", "1": null, "2": "Ian Somerhalder" }
}

Strict rules for speakers / speakerMap:
- ONE entry per distinct [Speaker N] number that appears in the transcript.
- If you can identify the name from the transcript (rules 1-3 above), include
  it in BOTH the speakers string ("Name (Speaker N)") and the speakerMap
  ({ "N": "Name" }).
- If you can't identify a name, use just "Speaker N" in speakers and null in
  speakerMap.
- If the transcript has NO [Speaker N] labels at all, return [] and {}.
- Be aggressive about finding names when they're stated, but do NOT invent
  names from topic/context alone.

Other rules:
- If a list has no items, return [].
- Do NOT include markdown, prose, or commentary outside the JSON.`;

function safeParseNotes(raw: string): NotesShape {
  const empty: NotesShape = {
    summary: '', actionItems: [], keyTopics: [], sentiment: 'neutral', decisions: [], speakers: [],
    speakerMap: {},
  };
  if (!raw) return empty;
  // LLMs occasionally wrap JSON in ```json fences. Strip them.
  const cleaned = raw
    .replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/m, '$1')
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Partial<NotesShape>;
    const arrStr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const sentiment = obj.sentiment;
    let speakerMap: Record<string, string | null> = {};
    if (obj.speakerMap && typeof obj.speakerMap === 'object' && !Array.isArray(obj.speakerMap)) {
      for (const [k, v] of Object.entries(obj.speakerMap as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim().length > 0) speakerMap[k] = v.trim();
        else speakerMap[k] = null;
      }
    }
    // Last-resort: derive speakerMap from "Name (Speaker N)" entries in
    // speakers[] if speakerMap wasn't returned at all.
    if (Object.keys(speakerMap).length === 0) {
      for (const s of arrStr(obj.speakers)) {
        const m = s.match(/^(.+?)\s*\(\s*Speaker\s+(\d+)\s*\)\s*$/i);
        if (m) speakerMap[m[2]!] = m[1]!.trim();
      }
    }
    return {
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      actionItems: arrStr(obj.actionItems),
      keyTopics: arrStr(obj.keyTopics),
      sentiment: sentiment === 'positive' || sentiment === 'negative' || sentiment === 'mixed' ? sentiment : 'neutral',
      decisions: arrStr(obj.decisions),
      speakers: arrStr(obj.speakers),
      speakerMap,
    };
  } catch {
    return empty;
  }
}

interface WhisperResult {
  text?: string;
  vtt?: string;
  word_count?: number;
  words?: { word: string; start: number; end: number; speaker?: number }[];
  transcription_info?: { language?: string; duration?: number };
}

const WORKERS_AI_SIZE_CUTOFF = 7 * 1024 * 1024; // ~7 MB — Workers AI 3006 cap
const OPENAI_WHISPER_LIMIT = 25 * 1024 * 1024;
const GEMINI_INLINE_LIMIT = 20 * 1024 * 1024;   // base64-inline ceiling for Gemini

interface OpenAiWhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  words?: { word: string; start: number; end: number }[];
}

interface DeepgramResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: Array<{
          word: string;
          start: number;
          end: number;
          punctuated_word?: string;
          speaker?: number;
          speaker_confidence?: number;
        }>;
      }>;
    }>;
  };
  metadata?: { duration?: number };
}

/**
 * Direct Deepgram batch transcription — bypasses the Workers AI body cap.
 * Handles audio up to 2 GB. BYOK key via DEEPGRAM_API_KEY worker secret.
 *
 * We use Nova-3 (Deepgram's flagship batch model) — same family as the
 * Flux STT we use for live calls and the Aura TTS we use for voiceovers.
 */
export async function transcribeViaDeepgram(
  apiKey: string,
  bytes: Uint8Array,
  mime: string,
): Promise<WhisperResult> {
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',           // speaker labels per word
    // Multilingual code-switching (English + Hindi + others in one file).
    // `detect_language` picks ONE dominant language and drops the rest — it
    // silently lost all Hindi in mixed en/hi calls. `language=multi` (Nova-3)
    // transcribes each language in place, incl. Devanagari Hindi.
    language: 'multi',
    paragraphs: 'true',
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': mime || 'audio/mpeg',
    },
    body: bytes,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Deepgram ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = (await res.json()) as DeepgramResponse;
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alt?.transcript ?? '';
  const words = (alt?.words ?? []).map((w) => ({
    word: w.punctuated_word ?? w.word,
    start: w.start,
    end: w.end,
    speaker: typeof w.speaker === 'number' ? w.speaker : undefined,
  }));
  return {
    text: transcript,
    words,
    transcription_info: { duration: json.metadata?.duration },
  };
}

interface GeminiUtterance { speaker: number; start: number; end: number; text: string }
interface GeminiTranscriptionPayload {
  transcript?: string;
  language?: string;
  durationSeconds?: number;
  utterances?: GeminiUtterance[];
}

/** Map Gemini's MIME quirks back to something its API accepts.
 *  Per Google docs, supported audio MIMEs are: audio/wav, audio/mp3,
 *  audio/aiff, audio/aac, audio/ogg, audio/flac, audio/mpeg.
 *  audio/mpeg works directly — no need to remap mp3. */
function normalizeMimeForGemini(mime: string): string {
  const m = mime.toLowerCase();
  if (m === 'audio/mpeg' || m === 'audio/mp3') return 'audio/mp3';
  if (m === 'audio/x-wav' || m === 'audio/wave') return 'audio/wav';
  if (m === 'audio/mp4' || m === 'audio/x-m4a' || m === 'audio/m4a') return 'audio/aac';
  if (m === 'audio/webm') return 'audio/ogg';   // webm-Opus → ogg container Gemini understands
  if (m === 'application/octet-stream') return 'audio/mp3'; // best guess
  return m;
}

/**
 * Gemini 2.5 Flash multimodal transcription with diarization.
 *
 * We pass the audio inline (base64) and a structured-output schema that asks
 * for speaker-tagged utterances with timestamps. Then we expand each utterance
 * into word-level entries (proportional timestamps) so the existing detail-
 * page transcript renderer Just Works.
 *
 * Quality trade-off vs Deepgram: Gemini is reasoning about voice differences
 * via its general multimodal stack rather than a tuned diarization model.
 * Two distinct speakers usually separate cleanly; three+ voices on noisy
 * audio gets shakier. Cost: ~$0.001 per ~30 sec of audio at gemini-2.5-flash.
 */
async function transcribeViaGemini(
  apiKey: string,
  bytes: Uint8Array,
  mime: string,
): Promise<WhisperResult> {
  const audioMime = normalizeMimeForGemini(mime);
  // Gemini API uses camelCase keys throughout. snake_case fails silently
  // (the model ignores the audio part and returns an empty/odd response,
  // which we then fall through past without distinct error).
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              "Produce a VERBATIM transcription of this audio recording. " +
              "REQUIREMENTS:\n" +
              "1. Include EVERY word that is spoken. Do not summarize, paraphrase, abridge, or skip any portion. Filler words ('um', 'uh', 'like', 'you know') should be included.\n" +
              "2. Cover the audio from start to end. Do not stop early.\n" +
              "3. Identify each distinct speaker. Tag every utterance with a speaker number (0, 1, 2, ...) in order of first appearance.\n" +
              "4. Provide accurate start/end timestamps in seconds for each utterance. The last utterance's end MUST be near the total audio duration.\n" +
              "5. Split utterances at speaker changes and at natural sentence boundaries — short utterances are fine, but keep complete sentences together when one speaker is talking continuously.\n" +
              "6. If you genuinely cannot separate speakers, return everything as speaker 0 (but try first).",
          },
          {
            inlineData: { mimeType: audioMime, data: bytesToBase64(bytes) },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          transcript: { type: 'string' },
          language: { type: 'string' },
          durationSeconds: { type: 'number' },
          utterances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'integer' },
                start: { type: 'number' },
                end: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['speaker', 'start', 'end', 'text'],
            },
          },
        },
        required: ['transcript', 'utterances'],
      },
      temperature: 0,
      // Maxed for gemini-2.5-flash (65 K). 2.0-flash caps at 8 K so it
      // silently truncates; we prefer 2.5-flash for that reason.
      maxOutputTokens: 65536,
    },
  };

  // Prefer 2.5-flash first — it has a 65 K output-token budget. 2.0-flash
  // caps at 8 K and was silently truncating long verbatim transcripts.
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr = '';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = `${model}: fetch threw (${(e as Error).message})`;
      continue;
    }
    clearTimeout(timer);
    if (res.status === 404) { lastErr = `${model}: 404`; continue; }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Gemini ${model} ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
        safetyRatings?: unknown;
      }>;
      promptFeedback?: { blockReason?: string };
    };
    if (json.promptFeedback?.blockReason) {
      throw new Error(`Gemini ${model}: blocked (${json.promptFeedback.blockReason})`);
    }
    const cand = json.candidates?.[0];
    const raw = cand?.content?.parts?.[0]?.text ?? '';
    if (!raw) {
      throw new Error(
        `Gemini ${model} returned empty body (finishReason: ${cand?.finishReason ?? 'none'}). ` +
        `Audio MIME ${audioMime} may not be supported, or the audio exceeds the model's inline budget.`,
      );
    }
    let parsed: GeminiTranscriptionPayload;
    try { parsed = JSON.parse(raw) as GeminiTranscriptionPayload; }
    catch { throw new Error(`Gemini JSON parse failed: ${raw.slice(0, 300)}`); }

    const utterances = parsed.utterances ?? [];
    if (utterances.length === 0) {
      throw new Error(
        `Gemini returned no utterances. transcript=${(parsed.transcript ?? '').slice(0, 100)}…`,
      );
    }
    // Convert utterances → word-level entries so the existing UI renders.
    const words: { word: string; start: number; end: number; speaker?: number }[] = [];
    for (const u of utterances) {
      const tokens = (u.text ?? '').split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const dur = Math.max(0, (u.end ?? u.start) - u.start);
      const per = dur > 0 ? dur / tokens.length : 0;
      for (let i = 0; i < tokens.length; i++) {
        words.push({
          word: tokens[i]!,
          start: u.start + i * per,
          end: u.start + (i + 1) * per,
          speaker: typeof u.speaker === 'number' ? u.speaker : 0,
        });
      }
    }
    const transcript = parsed.transcript || utterances.map((u) => u.text).join(' ');
    return {
      text: transcript,
      words,
      transcription_info: {
        language: parsed.language,
        duration: parsed.durationSeconds,
      },
    };
  }
  throw new Error(`Gemini: no usable model (${lastErr})`);
}

async function transcribeViaOpenAi(
  apiKey: string,
  bytes: Uint8Array,
  mime: string,
): Promise<WhisperResult> {
  const form = new FormData();
  // Wrap the bytes in a Blob — fetch will multipart-encode it correctly.
  const blob = new Blob([bytes], { type: mime || 'audio/mpeg' });
  form.append('file', blob, `audio.${mime.includes('wav') ? 'wav' : mime.includes('m4a') || mime.includes('mp4') ? 'm4a' : 'mp3'}`);
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI Whisper ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = (await res.json()) as OpenAiWhisperResponse;
  return {
    text: json.text,
    words: json.words ?? [],
    transcription_info: { language: json.language, duration: json.duration },
  };
}

/**
 * Tiered transcription router. Deepgram is the only path that produces
 * reliable per-word diarization (voice-pattern model — Gemini's multimodal
 * "reasoning" approach got speakers wrong too often). Whisper paths exist
 * only as a transcript-without-diarization fallback when Deepgram isn't
 * configured.
 *
 *   1. DEEPGRAM_API_KEY set      → Deepgram Nova-3 direct (any size,
 *                                  $0.0043/min + $0.001/min diarization)
 *   2. <7 MB, no Deepgram        → Workers AI Whisper turbo (free, no diarization)
 *   3. <25 MB + OPENAI_API_KEY   → OpenAI whisper-1 (no diarization)
 *   4. Otherwise                 → clear setup error.
 */
async function transcribeWhisper(env: Env, bytes: Uint8Array, mime: string): Promise<WhisperResult> {
  const env2 = env as unknown as {
    OPENAI_API_KEY?: string;
    DEEPGRAM_API_KEY?: string;
  };
  const sizeMb = bytes.length / 1024 / 1024;
  const tooBigForWorkersAi = bytes.length > WORKERS_AI_SIZE_CUTOFF;
  const tooBigForOpenAi = bytes.length > OPENAI_WHISPER_LIMIT;

  // Tier 1: Deepgram direct — preferred whenever the key is set.
  if (env2.DEEPGRAM_API_KEY) {
    return transcribeViaDeepgram(env2.DEEPGRAM_API_KEY, bytes, mime);
  }

  // Tier 2: Small file → Workers AI Whisper (free, no diarization).
  if (!tooBigForWorkersAi) {
    try {
      const res = await env.AI.run(
        '@cf/openai/whisper-large-v3-turbo' as never,
        { audio: bytes } as never,
      );
      return res as unknown as WhisperResult;
    } catch (e) {
      const msg = (e as Error).message;
      if (!/3006|too large|5006|Type mismatch/.test(msg)) throw e;
      console.warn('[notetaker] Workers AI Whisper rejected — falling through');
    }
  }

  // Tier 3: Medium file → OpenAI Whisper.
  if (!tooBigForOpenAi && env2.OPENAI_API_KEY) {
    return transcribeViaOpenAi(env2.OPENAI_API_KEY, bytes, mime);
  }

  // Nothing left — surface a useful setup error.
  if (tooBigForOpenAi) {
    throw new Error(
      `audio is ${sizeMb.toFixed(1)} MB — exceeds OpenAI Whisper's 25 MB limit. ` +
      'Configure DEEPGRAM_API_KEY as a Worker secret to transcribe files this large ' +
      '(Deepgram handles up to 2 GB, ~$0.0043/min + $0.001/min for diarization).',
    );
  }
  throw new Error(
    'no transcription key configured. Set DEEPGRAM_API_KEY (diarization, any size) ' +
    'or OPENAI_API_KEY (≤25 MB, no diarization). Get a Deepgram key with $200 free ' +
    'credit at console.deepgram.com.',
  );
}

/**
 * Format the words array as a speaker-labeled transcript:
 *   [Speaker 0] Hello, this is Alex.
 *   [Speaker 1] Hi Alex, I'm Mira.
 *
 * Falls back to plain text if no speaker info present.
 */
function renderSpeakerTranscript(
  text: string,
  words: { word: string; start: number; end: number; speaker?: number }[],
): string {
  const hasSpeakers = words.some((w) => typeof w.speaker === 'number');
  if (!hasSpeakers) return text;
  const lines: string[] = [];
  let currentSpeaker = -1;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) lines.push(`[Speaker ${currentSpeaker}] ${buf.join(' ')}`);
    buf = [];
  };
  for (const w of words) {
    const sp = w.speaker ?? -1;
    if (sp !== currentSpeaker) {
      flush();
      currentSpeaker = sp;
    }
    buf.push(w.word);
  }
  flush();
  return lines.join('\n');
}

export interface TimelineSegment { startMs: number; endMs: number; name: string }

/**
 * Map each transcriber speaker index (Deepgram's 0,1,2…) to a real participant
 * name by maximal temporal overlap with the recorder's who-spoke-when timeline.
 *
 * Word timestamps are in SECONDS; timeline segments are in MILLISECONDS from
 * recording start (same origin as the audio). Returns `{ "<index>": "<name>" }`
 * only for indices that have a clear overlap winner — indices with no timeline
 * overlap are left out, so the LLM's content-based guess can still fill them.
 */
export function alignSpeakerNames(
  words: { start: number; end: number; speaker?: number }[],
  timeline: TimelineSegment[],
): Record<string, string> {
  if (timeline.length === 0) return {};
  const overlap = new Map<number, Map<string, number>>(); // index -> name -> overlap ms
  for (const w of words) {
    if (typeof w.speaker !== 'number') continue;
    const wStart = w.start * 1000;
    const wEnd = w.end * 1000;
    if (!(wEnd > wStart)) continue;
    let perName = overlap.get(w.speaker);
    if (!perName) { perName = new Map(); overlap.set(w.speaker, perName); }
    for (const seg of timeline) {
      const ov = Math.min(wEnd, seg.endMs) - Math.max(wStart, seg.startMs);
      if (ov > 0) perName.set(seg.name, (perName.get(seg.name) ?? 0) + ov);
    }
  }
  const map: Record<string, string> = {};
  for (const [idx, perName] of overlap) {
    let best = '';
    let bestOv = 0;
    for (const [name, ov] of perName) {
      if (ov > bestOv) { bestOv = ov; best = name; }
    }
    if (best && bestOv > 0) map[String(idx)] = best;
  }
  return map;
}

/** Accept a form field only if it parses to a JSON array under the size cap;
 *  re-serialize it so we store canonical JSON. Returns null otherwise. */
function sanitizeJsonArray(raw: string | null, maxLen = 256 * 1024): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > maxLen) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? JSON.stringify(v) : null;
  } catch {
    return null;
  }
}

/** Parse the recorder's speaker-timeline JSON into validated segments. */
export function parseTimeline(raw: string | null | undefined): TimelineSegment[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.flatMap((s) =>
      s && typeof s === 'object'
        && typeof (s as TimelineSegment).startMs === 'number'
        && typeof (s as TimelineSegment).endMs === 'number'
        && typeof (s as TimelineSegment).name === 'string'
        ? [{ startMs: (s as TimelineSegment).startMs, endMs: (s as TimelineSegment).endMs, name: (s as TimelineSegment).name }]
        : [],
    );
  } catch {
    return [];
  }
}

type SpeakerWord = { word: string; start: number; end: number; speaker?: number };

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/**
 * Re-apply speaker labels from an LLM correction pass onto the original
 * timestamped words. The LLM regroups words by speaker — fixing Deepgram
 * diarization boundary errors (e.g. a single word stranded on the wrong
 * speaker across a pause) — but must NOT change the words themselves. We
 * verify that by matching tokens 1:1 against the originals. On ANY divergence
 * (reworded, dropped, or added tokens) we return the original labels untouched,
 * so a bad LLM response can never corrupt the transcript — only improve it.
 */
function realignSpeakers(
  words: SpeakerWord[],
  utterances: { speaker: number; text: string }[],
): SpeakerWord[] {
  const expectedTok: string[] = [];
  const expectedSpk: number[] = [];
  for (const u of utterances) {
    for (const t of u.text.split(/\s+/)) {
      const n = normalizeToken(t);
      if (!n) continue;
      expectedTok.push(n);
      expectedSpk.push(u.speaker);
    }
  }
  // Fail-safe: tokens must line up 1:1 with the original words, in order.
  if (expectedTok.length !== words.length) return words.map((w) => ({ ...w }));
  for (let i = 0; i < words.length; i++) {
    if (normalizeToken(words[i]!.word) !== expectedTok[i]) return words.map((w) => ({ ...w }));
  }
  return words.map((w, i) => ({ ...w, speaker: expectedSpk[i]! }));
}

/**
 * Parse the diarization-correction LLM response into ordered utterances.
 * Tolerates ```json fences / prose wrappers; drops malformed entries; returns
 * [] on any failure so the caller falls back to the original speaker labels.
 */
function parseCorrectionUtterances(raw: string): { speaker: number; text: string }[] {
  if (!raw) return [];
  const cleaned = raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/m, '$1').trim();
  try {
    const obj = JSON.parse(cleaned) as { utterances?: unknown };
    const arr = Array.isArray(obj.utterances) ? obj.utterances : [];
    const out: { speaker: number; text: string }[] = [];
    for (const u of arr) {
      if (!u || typeof u !== 'object') continue;
      const spk = (u as Record<string, unknown>).speaker;
      const text = (u as Record<string, unknown>).text;
      if (typeof spk === 'number' && Number.isFinite(spk) && typeof text === 'string' && text.trim().length > 0) {
        out.push({ speaker: spk, text });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Notes extractor — JSON-mode wherever possible so we don't depend on the
 * model "remembering" to return only JSON.
 *
 * Preference:
 *   1. OpenAI Responses API with response_format=json_object (reliable)
 *   2. Gemini with responseSchema (also reliable)
 *   3. Workers AI Llama as last resort (text mode, may fail safeParseNotes)
 */
async function generateNotes(
  env: Env,
  transcript: string,
  words: { word: string; start: number; end: number; speaker?: number }[],
  opts: { nameMap?: Record<string, string>; roster?: string[] } = {},
): Promise<NotesShape> {
  const env2 = env as unknown as { OPENAI_API_KEY?: string; GOOGLE_AI_API_KEY?: string };
  const labeledTranscript = renderSpeakerTranscript(transcript, words);
  // Seed the model with ground-truth identities from the meeting roster +
  // who-spoke-when timeline. The deterministic alignment overrides speakerMap
  // afterward regardless, but these hints let the summary use real names and
  // help fill any speaker indices the timeline didn't cover.
  const hints: string[] = [];
  if (opts.nameMap && Object.keys(opts.nameMap).length > 0) {
    hints.push(
      'Known speaker identities (from the meeting roster + who-spoke-when timeline, treat as ground truth): '
        + Object.entries(opts.nameMap).map(([i, n]) => `Speaker ${i} = ${n}`).join('; ') + '.',
    );
  }
  if (opts.roster && opts.roster.length > 0) {
    hints.push(`Meeting participants: ${opts.roster.join(', ')}.`);
  }
  const hintBlock = hints.length > 0 ? hints.join('\n') + '\n\n' : '';
  const userInput = `${hintBlock}Transcript:\n\n${labeledTranscript.slice(0, 24_000)}`;

  // Tier 1: OpenAI direct (JSON mode + 30s timeout — Responses API streaming
  // adapter wasn't enforcing JSON output, leading to "summarizing" finishing
  // but storing an empty notes shape).
  if (env2.OPENAI_API_KEY) {
    try {
      return await generateNotesOpenAi(env2.OPENAI_API_KEY, userInput);
    } catch (e) {
      console.warn('[notetaker-notes] OpenAI failed, falling through:', (e as Error).message);
    }
  }

  // Tier 2: Gemini with responseSchema.
  if (env2.GOOGLE_AI_API_KEY) {
    try {
      return await generateNotesGemini(env2.GOOGLE_AI_API_KEY, userInput);
    } catch (e) {
      console.warn('[notetaker-notes] Gemini failed, falling through:', (e as Error).message);
    }
  }

  // Tier 3: Workers AI Llama via the streaming adapter (no JSON mode — best
  // effort; safeParseNotes will salvage if possible).
  const llm: LlmPort = new WorkersAiLlm(env.AI, {
    onError: (m, d) => console.warn('[notetaker-llm]', m, d),
  });
  const messages: Message[] = [
    { role: 'system', content: NOTES_PROMPT },
    { role: 'user', content: userInput },
  ];
  let out = '';
  for await (const d of llm.generate(messages)) {
    if (d.type === 'text') out += d.text;
    if (d.type === 'done') break;
  }
  if (!out.trim()) console.warn('[notetaker-notes] Workers AI Llama returned empty body');
  return safeParseNotes(out);
}

async function generateNotesOpenAi(apiKey: string, userInput: string): Promise<NotesShape> {
  // chat.completions with response_format=json_object is the simplest reliable
  // way to force JSON output. We don't need streaming for the notes pass.
  // Hard 90s timeout so a hung remote can't pin the job in 'summarizing' forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NOTES_PROMPT },
          { role: 'user', content: userInput },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content) throw new Error('OpenAI returned empty content');
    return safeParseNotes(content);
  } finally {
    clearTimeout(timer);
  }
}

async function generateNotesGemini(apiKey: string, userInput: string): Promise<NotesShape> {
  const body = {
    contents: [{ parts: [{ text: `${NOTES_PROMPT}\n\n---\n\n${userInput}` }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          actionItems: { type: 'array', items: { type: 'string' } },
          keyTopics: { type: 'array', items: { type: 'string' } },
          sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
          decisions: { type: 'array', items: { type: 'string' } },
          speakers: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'actionItems', 'keyTopics', 'sentiment', 'decisions', 'speakers'],
      },
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr = '';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.status === 404) { lastErr = `${model}: 404`; continue; }
      if (!res.ok) {
        throw new Error(`Gemini ${model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      }
      const j = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const content = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!content) throw new Error('Gemini returned empty content');
      return safeParseNotes(content);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Gemini: no usable model (${lastErr})`);
}

const CORRECTION_PROMPT = `You correct speaker diarization on a transcript.

You are given a transcript where each line is tagged with a speaker number,
but some words are attributed to the WRONG speaker — diarization engines
routinely mis-assign words at sentence boundaries and across pauses (e.g. a
single word like "Welcome" gets stranded on the previous speaker even though
it begins the next speaker's sentence).

Your task: regroup the EXACT SAME WORDS into utterances by their correct
speaker, using linguistic continuity. A complete sentence ("Welcome back to
California.") belongs to ONE speaker. A question and its answer are DIFFERENT
speakers.

CRITICAL RULES:
- Reproduce every word EXACTLY as it appears, in the EXACT SAME ORDER. Do NOT
  add, remove, rephrase, correct, translate, or merge any word.
- Only change which speaker each word is grouped under.
- Reuse ONLY the speaker numbers present in the input. Do NOT invent new ones.
- Return ONLY a JSON object: {"utterances":[{"speaker":<int>,"text":"..."}]}`;

/**
 * Diarization-correction pass. Deepgram's per-word speaker labels have boundary
 * errors on conversational single-channel audio; an LLM with linguistic context
 * regroups the words by their true speaker. We never trust the LLM to change
 * words — realignSpeakers re-applies only the speaker labels, 1:1 against the
 * originals, and any divergence falls back to the untouched input. Skipped
 * unless there are ≥2 real speakers to disambiguate.
 */
async function correctSpeakers(env: Env, words: SpeakerWord[]): Promise<SpeakerWord[]> {
  const env2 = env as unknown as { OPENAI_API_KEY?: string; GOOGLE_AI_API_KEY?: string };
  const distinct = new Set(words.map((w) => w.speaker).filter((s): s is number => typeof s === 'number'));
  if (distinct.size < 2) return words;
  if (!env2.OPENAI_API_KEY && !env2.GOOGLE_AI_API_KEY) return words;

  const labeled = renderSpeakerTranscript('', words).slice(0, 24_000);
  if (!labeled.trim()) return words;

  try {
    let raw = '';
    if (env2.OPENAI_API_KEY) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env2.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: CORRECTION_PROMPT },
              { role: 'user', content: labeled },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 4096,
          }),
          signal: ac.signal,
        });
        if (res.ok) {
          const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          raw = j.choices?.[0]?.message?.content ?? '';
        }
      } finally {
        clearTimeout(timer);
      }
    }
    if (!raw && env2.GOOGLE_AI_API_KEY) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env2.GOOGLE_AI_API_KEY}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${CORRECTION_PROMPT}\n\n---\n\n${labeled}` }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
          }),
          signal: ac.signal,
        });
        if (res.ok) {
          const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
          raw = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        }
      } finally {
        clearTimeout(timer);
      }
    }
    const utterances = parseCorrectionUtterances(raw);
    if (utterances.length === 0) return words;
    return realignSpeakers(words, utterances);
  } catch (e) {
    console.warn('[notetaker] speaker correction failed, keeping original labels:', (e as Error).message);
    return words;
  }
}

/**
 * Process one job — transcription + notes. Called inline from the upload
 * handler so the work has the full request lifetime (and visibility) rather
 * than being orphaned by ctx.waitUntil, which we observed dying mid-execution
 * with no error trail. Upload response is slower (~30-60s for typical meeting
 * audio) but the job actually completes; the detail page polls anyway.
 */
async function processJob(env: Env, jobId: string, tenantId: string): Promise<void> {
  async function fail(msg: string): Promise<void> {
    await env.DB.prepare(
      `UPDATE notetaker_jobs SET status='failed', error=?, completed_at=? WHERE id=? AND tenant_id=?`,
    ).bind(msg.slice(0, 500), now(), jobId, tenantId).run().catch(() => {});
    console.error('[notetaker]', jobId, 'failed', msg);
  }

  try {
    const row = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=? AND tenant_id=?')
      .bind(jobId, tenantId).first<JobRow>();
    if (!row) return;
    // Queue redelivery must never double-process a finished job.
    if (row.status === 'ready' || row.status === 'failed') return;

    await env.DB.prepare(`UPDATE notetaker_jobs SET status='transcribing' WHERE id=?`).bind(jobId).run();

    const obj = await env.RECORDINGS.get(row.audio_r2_key);
    if (!obj) { await fail('audio missing from R2'); return; }
    const buf = await obj.arrayBuffer();
    const audio = new Uint8Array(buf);

    const whisper = await transcribeWhisper(env, audio, row.mime_type);
    const transcript = (whisper.text ?? '').trim();
    if (!transcript) { await fail('transcription returned empty text'); return; }

    const rawWords = Array.isArray(whisper.words) ? whisper.words : [];
    // Diarization-correction pass: fix Deepgram's word-boundary speaker
    // mis-attributions before we store/render. Falls back to rawWords on any
    // failure, so this can only improve labels, never corrupt them.
    const words = await correctSpeakers(env, rawWords);
    const duration = whisper.transcription_info?.duration ?? null;
    const transcribedAt = now();
    await env.DB.prepare(
      `UPDATE notetaker_jobs
         SET status='summarizing', transcript_text=?, transcript_words=?,
             audio_duration_sec=COALESCE(audio_duration_sec, ?),
             chars=?, transcribed_at=?
       WHERE id=?`,
    ).bind(
      transcript, JSON.stringify(words), duration ? Math.round(duration) : null,
      transcript.length, transcribedAt, jobId,
    ).run();

    // Diarization by real name: align transcriber speaker indices to the
    // meeting roster via the recorder's who-spoke-when timeline.
    const timeline = parseTimeline(row.speaker_timeline_json);
    let roster: string[] = [];
    try {
      const v = JSON.parse(row.participants_json ?? '[]');
      if (Array.isArray(v)) roster = v.filter((x): x is string => typeof x === 'string');
    } catch { /* ignore malformed roster */ }
    const timelineMap = alignSpeakerNames(words, timeline);

    const notes = await generateNotes(env, transcript, words, { nameMap: timelineMap, roster });

    // Server-side enforcement: if the words array has no real diarization
    // info, the LLM has no business naming speakers — strip whatever it
    // came up with. (gpt-4o-mini was inferring speakers from conversational
    // structure despite the strict prompt.)
    const hasRealSpeakers = words.some((w) => typeof w.speaker === 'number');
    if (!hasRealSpeakers) {
      notes.speakers = [];
      notes.speakerMap = {};
    } else if (Object.keys(timelineMap).length > 0) {
      // Timeline-derived names are ground truth — they win over the LLM's
      // content-based guesses; the LLM fills indices the timeline didn't cover.
      for (const [idx, name] of Object.entries(timelineMap)) notes.speakerMap[idx] = name;
      notes.speakers = Object.entries(notes.speakerMap)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([idx, name]) => (name ? `${name} (Speaker ${idx})` : `Speaker ${idx}`));
    }

    await env.DB.prepare(
      `UPDATE notetaker_jobs
         SET status='ready', notes_json=?, completed_at=?
       WHERE id=?`,
    ).bind(JSON.stringify(notes), now(), jobId).run();

    console.log('[notetaker]', jobId, 'ready', { chars: transcript.length });
  } catch (e) {
    await fail(`processing error: ${(e as Error).message}`);
  }
}

const WEBHOOK_MAX_ATTEMPTS = 5;

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deliver the job-finished webhook: a JSON payload signed with the tenant's
 * webhook secret (HMAC-SHA256 over the raw body). Throws on any failure so
 * the queue redelivers; the consumer caps attempts at WEBHOOK_MAX_ATTEMPTS.
 */
export async function deliverWebhook(
  env: Env,
  jobId: string,
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=? AND tenant_id=?')
    .bind(jobId, tenantId).first<JobRow>();
  if (!row?.webhook_url || row.webhook_status === 'delivered') return;

  const tenant = await env.DB.prepare('SELECT webhook_secret FROM tenants WHERE id = ?')
    .bind(tenantId).first<{ webhook_secret: string | null }>();
  const secret = tenant?.webhook_secret ?? '';

  const body = JSON.stringify({
    event: row.status === 'failed' ? 'notetaker.failed' : 'notetaker.ready',
    notetaker: rowToJson(row),
  });

  let res: Response;
  try {
    res = await fetchImpl(row.webhook_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Notetaker-Signature': `sha256=${await hmacSha256Hex(secret, body)}`,
        'X-Notetaker-Delivery': uuid(),
      },
      body,
    });
  } catch (e) {
    await env.DB.prepare('UPDATE notetaker_jobs SET webhook_attempts = webhook_attempts + 1 WHERE id=?')
      .bind(jobId).run().catch(() => {});
    throw new Error(`webhook fetch threw: ${(e as Error).message}`);
  }
  if (!res.ok) {
    await env.DB.prepare('UPDATE notetaker_jobs SET webhook_attempts = webhook_attempts + 1 WHERE id=?')
      .bind(jobId).run().catch(() => {});
    throw new Error(`webhook delivery failed: status ${res.status}`);
  }
  await env.DB.prepare(
    `UPDATE notetaker_jobs SET webhook_status='delivered', webhook_attempts = webhook_attempts + 1 WHERE id=?`,
  ).bind(jobId).run();
}

interface QueueMsg {
  body: NotetakerQueueMessage;
  attempts: number;
  retry(): void;
  ack(): void;
}

/** Injectable seams so tests don't run the real transcription pipeline. */
export interface NotetakerQueueDeps {
  processJobImpl?: (env: Env, jobId: string, tenantId: string) => Promise<void>;
  deliverWebhookImpl?: (env: Env, jobId: string, tenantId: string) => Promise<void>;
}

/**
 * Queue consumer. 'process' runs the pipeline then enqueues a 'webhook'
 * message if the job asked for one. 'webhook' delivers; failures retry via
 * the queue until WEBHOOK_MAX_ATTEMPTS, then the job is marked
 * webhook_status='failed' and the message acked (job stays pollable).
 */
export async function handleNotetakerQueue(
  batch: { messages: QueueMsg[] },
  env: Env,
  deps: NotetakerQueueDeps = {},
): Promise<void> {
  const processImpl = deps.processJobImpl ?? processJob;
  const deliverImpl = deps.deliverWebhookImpl
    ?? ((e: Env, id: string, t: string) => deliverWebhook(e, id, t));

  for (const m of batch.messages) {
    const { kind, jobId, tenantId } = m.body;
    try {
      if (kind === 'process') {
        await processImpl(env, jobId, tenantId);
        const row = await env.DB.prepare('SELECT webhook_url FROM notetaker_jobs WHERE id=? AND tenant_id=?')
          .bind(jobId, tenantId).first<{ webhook_url: string | null }>();
        if (row?.webhook_url) {
          await getQueue(env).send({ kind: 'webhook', jobId, tenantId });
        }
      } else if (kind === 'webhook') {
        await deliverImpl(env, jobId, tenantId);
      }
      m.ack();
    } catch (e) {
      if (kind === 'webhook' && m.attempts >= WEBHOOK_MAX_ATTEMPTS) {
        await env.DB.prepare(`UPDATE notetaker_jobs SET webhook_status='failed' WHERE id=? AND tenant_id=?`)
          .bind(jobId, tenantId).run().catch(() => {});
        console.error('[notetaker-queue] webhook gave up after', m.attempts, 'attempts:', jobId);
        m.ack();
      } else {
        console.warn('[notetaker-queue]', kind, jobId, 'attempt', m.attempts, 'failed:', (e as Error).message);
        m.retry();
      }
    }
  }
}

interface RuntimeCtx {
  waitUntil(p: Promise<unknown>): void;
}

export async function handleNotetakerApi(
  request: Request,
  env: Env,
  ctx: RuntimeCtx,
  authResult: { tenantId: string; userId?: string } | null,
): Promise<Response | null> {
  if (!NOTETAKER_ENABLED) return null;
  const url = new URL(request.url);
  // Public versioned alias: /api/v1/notetaker* is the same surface.
  const path = url.pathname.replace(/^\/api\/v1\/notetaker/, '/api/notetaker');
  const method = request.method;

  if (!path.startsWith('/api/notetaker')) return null;
  if (!authResult) return err(401, 'unauthorized');
  const auth = authResult;

  // GET /api/notetaker — list
  if (path === '/api/notetaker' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM notetaker_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
    ).bind(auth.tenantId).all<JobRow>();
    return json({ notetaker: results.map(rowToJson) });
  }

  // POST /api/notetaker — multipart upload
  if (path === '/api/notetaker' && method === 'POST') {
    if (!auth.userId) return err(403, 'user context required');
    const ct = request.headers.get('content-type') ?? '';
    if (!ct.includes('multipart/form-data')) {
      return err(400, 'expected multipart/form-data with `audio` field');
    }
    let form: FormData;
    try { form = await request.formData(); } catch { return err(400, 'invalid multipart payload'); }
    const file = form.get('audio');
    const title = (form.get('title') as string | null) ?? '';
    const webhookUrl = ((form.get('webhookUrl') as string | null) ?? '').trim();
    // Optional diarization sidecars from the recorder bot: participant roster +
    // who-spoke-when timeline. Stored verbatim if they parse to JSON arrays.
    const participantsJson = sanitizeJsonArray(form.get('participants') as string | null);
    const speakerTimelineJson = sanitizeJsonArray(form.get('speakerTimeline') as string | null);
    if (!(file instanceof File)) return err(400, '`audio` form field must be a File');
    if (file.size === 0) return err(400, 'empty audio file');
    if (file.size > MAX_AUDIO_BYTES) {
      return err(413, `audio exceeds ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit`);
    }
    if (webhookUrl && !/^https:\/\/.+/.test(webhookUrl)) {
      return err(400, 'webhookUrl must be an https:// URL');
    }
    if (webhookUrl.length > 2048) return err(400, 'webhookUrl too long');
    const mime = (file.type || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_MIME.has(mime) && !mime.startsWith('audio/')) {
      return err(415, `unsupported mime type: ${mime}`);
    }

    const id = uuid();
    const r2Key = `notetaker/${auth.tenantId}/${id}.${extFromMime(mime)}`;
    const createdAt = now();
    const bytes = await file.arrayBuffer();

    await env.RECORDINGS.put(r2Key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: 'private, max-age=86400' },
    });

    const row: JobRow = {
      id, tenant_id: auth.tenantId, user_id: auth.userId, title: title.trim() || null,
      audio_r2_key: r2Key, audio_size_bytes: file.size, audio_duration_sec: null,
      mime_type: mime, status: 'queued', error: null, transcript_text: null,
      transcript_words: null, notes_json: null, chars: null, cost_usd_micro: null,
      created_at: createdAt, transcribed_at: null, completed_at: null,
      webhook_url: webhookUrl || null, webhook_status: null, webhook_attempts: 0,
      participants_json: participantsJson, speaker_timeline_json: speakerTimelineJson,
    };
    await env.DB.prepare(
      `INSERT INTO notetaker_jobs
        (id, tenant_id, user_id, title, audio_r2_key, audio_size_bytes, audio_duration_sec,
         mime_type, status, error, transcript_text, transcript_words, notes_json,
         chars, cost_usd_micro, created_at, transcribed_at, completed_at, webhook_url,
         participants_json, speaker_timeline_json)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?)`,
    ).bind(
      id, auth.tenantId, auth.userId, row.title, r2Key, file.size, mime, createdAt,
      row.webhook_url, participantsJson, speakerTimelineJson,
    ).run();

    // Async: a Cloudflare Queue consumer runs the pipeline (transcribe +
    // notes) and delivers the webhook. waitUntil() is NOT used here — it was
    // observed dying mid-execution with no error trail.
    await getQueue(env).send({ kind: 'process', jobId: id, tenantId: auth.tenantId });

    return json({ notetaker: rowToJson(row) }, { status: 202 });
  }

  // GET /api/notetaker/:id/audio
  const audioMatch = path.match(/^\/api\/notetaker\/([a-f0-9-]+)\/audio$/);
  if (audioMatch && method === 'GET') {
    const id = audioMatch[1]!;
    const row = await env.DB.prepare(
      'SELECT audio_r2_key, mime_type FROM notetaker_jobs WHERE id=? AND tenant_id=?',
    ).bind(id, auth.tenantId).first<{ audio_r2_key: string; mime_type: string }>();
    if (!row) return err(404, 'notetaker job not found');
    const obj = await env.RECORDINGS.get(row.audio_r2_key);
    if (!obj) return err(404, 'audio missing');
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? row.mime_type,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  // GET /api/notetaker/:id
  const oneMatch = path.match(/^\/api\/notetaker\/([a-f0-9-]+)$/);
  if (oneMatch && method === 'GET') {
    const id = oneMatch[1]!;
    const row = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=? AND tenant_id=?')
      .bind(id, auth.tenantId).first<JobRow>();
    if (!row) return err(404, 'notetaker job not found');
    return json({ notetaker: rowToJson(row) });
  }

  // POST /api/notetaker/:id/retry — re-queue a failed job
  const retryMatch = path.match(/^\/api\/notetaker\/([a-f0-9-]+)\/retry$/);
  if (retryMatch && method === 'POST') {
    const id = retryMatch[1]!;
    const row = await env.DB.prepare('SELECT id, status FROM notetaker_jobs WHERE id=? AND tenant_id=?')
      .bind(id, auth.tenantId).first<{ id: string; status: string }>();
    if (!row) return err(404, 'notetaker job not found');
    if (row.status === 'transcribing' || row.status === 'summarizing') {
      return err(409, 'job already in progress');
    }
    await env.DB.prepare(
      `UPDATE notetaker_jobs SET status='queued', error=NULL, completed_at=NULL WHERE id=?`,
    ).bind(id).run();
    await processJob(env, id, auth.tenantId);
    const updated = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=?').bind(id).first<JobRow>();
    return json({ notetaker: rowToJson(updated!) }, { status: 200 });
  }

  // DELETE /api/notetaker/:id
  if (oneMatch && method === 'DELETE') {
    const id = oneMatch[1]!;
    const row = await env.DB.prepare(
      'SELECT audio_r2_key FROM notetaker_jobs WHERE id=? AND tenant_id=?',
    ).bind(id, auth.tenantId).first<{ audio_r2_key: string }>();
    if (!row) return err(404, 'notetaker job not found');
    await env.RECORDINGS.delete(row.audio_r2_key).catch(() => {});
    await env.DB.prepare('DELETE FROM notetaker_jobs WHERE id=? AND tenant_id=?')
      .bind(id, auth.tenantId).run();
    return json({ ok: true });
  }

  return err(404, 'not found');
}

export { safeParseNotes, realignSpeakers, parseCorrectionUtterances, processJob };
