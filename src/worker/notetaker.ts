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
}

interface NotesShape {
  summary: string;
  actionItems: string[];
  keyTopics: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  decisions: string[];
  speakers: string[];
}

function rowToJson(r: JobRow): Record<string, unknown> {
  let words: unknown[] = [];
  try { const v = JSON.parse(r.transcript_words ?? '[]'); if (Array.isArray(v)) words = v; } catch { /* ignore */ }
  let notes: unknown = null;
  try { notes = r.notes_json ? JSON.parse(r.notes_json) : null; } catch { notes = null; }
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

Return ONLY a single JSON object with these exact keys:
{
  "summary": "2-3 sentences of what this call/meeting was about",
  "actionItems": ["concrete next-step #1", "..."],
  "keyTopics": ["topic #1", "..."],
  "sentiment": "positive" | "neutral" | "negative" | "mixed",
  "decisions": ["decision reached on..."],
  "speakers": ["distinct named participants if identifiable"]
}

- If a list has no items, return [].
- Do NOT include markdown, prose, or commentary outside the JSON.
- Speakers come from the content (e.g. "Alex said…", "Mira mentioned…").
  If you can't identify speakers, return [].`;

function safeParseNotes(raw: string): NotesShape {
  const empty: NotesShape = {
    summary: '', actionItems: [], keyTopics: [], sentiment: 'neutral', decisions: [], speakers: [],
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
    return {
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      actionItems: arrStr(obj.actionItems),
      keyTopics: arrStr(obj.keyTopics),
      sentiment: sentiment === 'positive' || sentiment === 'negative' || sentiment === 'mixed' ? sentiment : 'neutral',
      decisions: arrStr(obj.decisions),
      speakers: arrStr(obj.speakers),
    };
  } catch {
    return empty;
  }
}

interface WhisperResult {
  text?: string;
  vtt?: string;
  word_count?: number;
  words?: { word: string; start: number; end: number }[];
  transcription_info?: { language?: string; duration?: number };
}

async function transcribeWhisper(ai: Ai, bytes: Uint8Array): Promise<WhisperResult> {
  // Workers AI Whisper expects audio as an array of byte values.
  const res = await ai.run(
    '@cf/openai/whisper-large-v3-turbo' as never,
    { audio: [...bytes] } as never,
  );
  return res as unknown as WhisperResult;
}

async function generateNotes(env: Env, transcript: string): Promise<NotesShape> {
  const env2 = env as unknown as { OPENAI_API_KEY?: string };
  let llm: LlmPort;
  if (env2.OPENAI_API_KEY) {
    llm = new OpenAiLlm(env2.OPENAI_API_KEY, 'gpt-4o-mini', {
      onError: (m, d) => console.warn('[notetaker-llm]', m, d),
    });
  } else {
    llm = new WorkersAiLlm(env.AI, { onError: (m, d) => console.warn('[notetaker-llm]', m, d) });
  }
  const messages: Message[] = [
    { role: 'system', content: NOTES_PROMPT },
    { role: 'user', content: `Transcript:\n\n${transcript.slice(0, 24_000)}` }, // safety cap for LLM context
  ];
  let out = '';
  for await (const d of llm.generate(messages)) {
    if (d.type === 'text') out += d.text;
    if (d.type === 'done') break;
  }
  return safeParseNotes(out);
}

/**
 * Background processing for one job. Runs inside ctx.waitUntil so the
 * upload response returns in <1s; the heavy work continues afterward.
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

    await env.DB.prepare(`UPDATE notetaker_jobs SET status='transcribing' WHERE id=?`).bind(jobId).run();

    const obj = await env.RECORDINGS.get(row.audio_r2_key);
    if (!obj) { await fail('audio missing from R2'); return; }
    const buf = await obj.arrayBuffer();
    const audio = new Uint8Array(buf);

    const whisper = await transcribeWhisper(env.AI, audio);
    const transcript = (whisper.text ?? '').trim();
    if (!transcript) { await fail('transcription returned empty text'); return; }

    const words = Array.isArray(whisper.words) ? whisper.words : [];
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

    const notes = await generateNotes(env, transcript);

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
  const path = url.pathname;
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
    if (!(file instanceof File)) return err(400, '`audio` form field must be a File');
    if (file.size === 0) return err(400, 'empty audio file');
    if (file.size > MAX_AUDIO_BYTES) {
      return err(413, `audio exceeds ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit`);
    }
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

    await env.DB.prepare(
      `INSERT INTO notetaker_jobs
        (id, tenant_id, user_id, title, audio_r2_key, audio_size_bytes, audio_duration_sec,
         mime_type, status, error, transcript_text, transcript_words, notes_json,
         chars, cost_usd_micro, created_at, transcribed_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
    ).bind(
      id, auth.tenantId, auth.userId, title.trim() || null, r2Key, file.size, mime, createdAt,
    ).run();

    // Kick off background processing — response returns immediately.
    ctx.waitUntil(processJob(env, id, auth.tenantId));

    const row = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=?').bind(id).first<JobRow>();
    return json({ notetaker: rowToJson(row!) }, { status: 202 });
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
    ctx.waitUntil(processJob(env, id, auth.tenantId));
    const updated = await env.DB.prepare('SELECT * FROM notetaker_jobs WHERE id=?').bind(id).first<JobRow>();
    return json({ notetaker: rowToJson(updated!) }, { status: 202 });
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

export { safeParseNotes };
