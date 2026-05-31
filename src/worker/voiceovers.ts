// Voiceovers — isolated module for async video-voiceover generation.
// Disable by flipping VOICEOVERS_ENABLED to false; the worker stops routing
// /api/voiceovers/* and the frontend (web/src/lib/features.ts) hides the nav.
//
// Pillars: quality > cost > speed. We route language → best provider:
//   en-* → Aura-2 EN (HD, fast, $0.022/min)
//   es-* → Aura-2 ES (HD, fast, $0.022/min)
//   else → Gemini Flash multilingual (slow, BYOK)

import { synthesizeTts } from './adapters';
import { authenticate } from './api';
import { err, json, now, uuid } from './util';

export const VOICEOVERS_ENABLED = true;

const MAX_CHARS = 5000;

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

/**
 * Pure function: BCP-47 language code → preferred provider.
 * Falls back to Gemini for anything we don't have an HD Aura voice for.
 */
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
    pricePerMinUsd: 0.0, // BYOK — Google bills the user directly
  };
}

// Voice catalogue (kept server-side so the voices endpoint stays the single source of truth).
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

interface VoiceMeta {
  id: string;
  label: string;
  gender?: 'female' | 'male';
}

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
}

function rowToJson(r: JobRow): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title ?? '',
    scriptText: r.script_text,
    voiceId: r.voice_id,
    model: r.model,
    language: r.language,
    format: r.format,
    chars: r.chars,
    durationMs: r.duration_ms,
    costUsdMicro: r.cost_usd_micro,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    renderedAt: r.rendered_at,
    audioUrl: `/api/voiceovers/${r.id}/audio`,
  };
}

interface CreateBody {
  scriptText?: unknown;
  voiceId?: unknown;
  language?: unknown;
  title?: unknown;
}

/**
 * Route dispatcher. Returns null if the path isn't ours, letting the worker
 * fall through to the SPA. All responses are JSON or audio bytes.
 */
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

  // Public sub-paths still need auth — voiceovers is fully tenant-scoped.
  if (!authResult) return err(401, 'unauthorized');
  const auth = authResult;

  // GET /api/voiceovers/voices?lang=xx-XX  — voice list for routed provider
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

  // GET /api/voiceovers  — list jobs for tenant
  if (path === '/api/voiceovers' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM voiceover_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(auth.tenantId)
      .all<JobRow>();
    return json({ voiceovers: results.map(rowToJson) });
  }

  // POST /api/voiceovers  — synthesize + persist
  if (path === '/api/voiceovers' && method === 'POST') {
    const body = (await request.json().catch(() => null)) as CreateBody | null;
    if (!body) return err(400, 'invalid body');
    const scriptText = typeof body.scriptText === 'string' ? body.scriptText.trim() : '';
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : '';
    const language = typeof body.language === 'string' ? body.language : 'en-US';
    const title = typeof body.title === 'string' ? body.title.trim() : '';

    if (!scriptText) return err(400, 'scriptText is required');
    if (scriptText.length > MAX_CHARS) return err(400, `script exceeds ${MAX_CHARS} character limit`);
    if (!voiceId) return err(400, 'voiceId is required');

    const provider = pickProvider(language);
    const allowedVoices = new Set(voicesForProvider(provider).map((v) => v.id));
    if (!allowedVoices.has(voiceId)) {
      return err(400, `voice "${voiceId}" is not valid for language "${language}"`);
    }
    if (!auth.userId) return err(403, 'user context required');

    const id = uuid();
    const r2Key = `voiceovers/${auth.tenantId}/${id}.${provider.format}`;
    const createdAt = now();

    // Render synchronously (≤2 min audio jobs only — fine within Worker wall-clock).
    try {
      const env2 = env as unknown as { GOOGLE_AI_API_KEY?: string };
      const { bytes, contentType } = await synthesizeTts({
        ai: env.AI,
        googleApiKey: env2.GOOGLE_AI_API_KEY,
        voiceId,
        text: scriptText,
      });

      await env.RECORDINGS.put(r2Key, bytes, {
        httpMetadata: { contentType, cacheControl: 'private, max-age=86400' },
      });

      const durationMs = estimateDuration(scriptText, provider);
      const costUsdMicro = Math.round((durationMs / 60_000) * provider.pricePerMinUsd * 1_000_000);

      await env.DB.prepare(
        `INSERT INTO voiceover_jobs
         (id, tenant_id, user_id, title, script_text, voice_id, model, language, format,
          chars, duration_ms, cost_usd_micro, r2_key, status, error, created_at, rendered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?)`,
      )
        .bind(
          id, auth.tenantId, auth.userId, title || null, scriptText, voiceId, provider.model,
          language, provider.format, scriptText.length, durationMs, costUsdMicro, r2Key,
          createdAt, now(),
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM voiceover_jobs WHERE id = ?').bind(id).first<JobRow>();
      return json({ voiceover: rowToJson(row!) }, { status: 201 });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await env.DB.prepare(
        `INSERT INTO voiceover_jobs
         (id, tenant_id, user_id, title, script_text, voice_id, model, language, format,
          chars, duration_ms, cost_usd_micro, r2_key, status, error, created_at, rendered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'failed', ?, ?, NULL)`,
      )
        .bind(
          id, auth.tenantId, auth.userId, title || null, scriptText, voiceId, provider.model,
          language, provider.format, scriptText.length, r2Key, msg, createdAt,
        )
        .run();
      return err(500, msg || 'render failed');
    }
  }

  // GET /api/voiceovers/:id/audio  — stream the audio bytes
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
    const contentType = row.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? contentType,
        'cache-control': 'private, max-age=3600',
      },
    });
  }

  // GET /api/voiceovers/:id  — single row
  const oneMatch = path.match(/^\/api\/voiceovers\/([a-f0-9-]+)$/);
  if (oneMatch && method === 'GET') {
    const id = oneMatch[1]!;
    const row = await env.DB.prepare('SELECT * FROM voiceover_jobs WHERE id = ? AND tenant_id = ?')
      .bind(id, auth.tenantId)
      .first<JobRow>();
    if (!row) return err(404, 'voiceover not found');
    return json({ voiceover: rowToJson(row) });
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
    await env.DB.prepare('DELETE FROM voiceover_jobs WHERE id = ? AND tenant_id = ?')
      .bind(id, auth.tenantId)
      .run();
    return json({ ok: true });
  }

  return err(404, 'not found');
}

/**
 * Coarse duration estimate from char count. English ~15 chars/sec at natural pace;
 * Spanish slightly faster; Gemini's expressive style runs slower. Good enough
 * for cost attribution + UI duration badge; replace with actual audio probe if needed.
 */
function estimateDuration(text: string, provider: Provider): number {
  const charsPerSec = provider.voicePrefix === 'gemini' ? 12 : 15;
  return Math.round((text.length / charsPerSec) * 1000);
}

// Re-export the auth helper to keep the module's import surface flat.
export { authenticate };
