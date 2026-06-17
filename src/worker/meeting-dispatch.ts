// Meeting dispatch — paste a Google Meet link in the dashboard and the
// recorder bot joins, records, and uploads into the caller's tenant.
//
// The recorder runs as a Cloudflare Container attached to this worker via the
// RECORDER Durable Object binding (see recorder-container.ts) — it has no
// public URL. RECORDER_CONTROL_SECRET authenticates worker→recorder calls and
// is also injected into the container so both sides agree. Each dispatch
// mints a tenant API key for the bot's upload, so the recording lands in the
// right account (visible/revocable on the API Keys page as
// "meeting bot (auto)").

import { mintApiKey } from './api-keys';
import { err, json } from './util';

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z0-9?&=_.-]+$/i;

// All recorder sessions share one container instance; the service inside
// multiplexes sessions up to MAX_CONCURRENT.
const RECORDER_INSTANCE = 'main';

interface RecorderEnv {
  RECORDER?: DurableObjectNamespace;
  RECORDER_CONTROL_SECRET?: string;
}

function recorderStub(env: Env): { fetch: typeof fetch; secret: string } | null {
  const cfg = env as unknown as RecorderEnv;
  const ns = cfg.RECORDER;
  const secret = cfg.RECORDER_CONTROL_SECRET ?? '';
  if (!ns || !secret) return null;
  const stub = ns.get(ns.idFromName(RECORDER_INSTANCE));
  return { fetch: stub.fetch.bind(stub) as typeof fetch, secret };
}

export async function handleMeetingDispatchApi(
  request: Request,
  env: Env,
  auth: { tenantId: string; userId?: string } | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/notetaker/meetings')) return null;
  if (!auth) return err(401, 'unauthorized');

  const recorder = recorderStub(env);
  if (!recorder) {
    return err(503, 'recorder not configured: deploy the recorder container and set the RECORDER_CONTROL_SECRET worker secret');
  }

  // POST /api/notetaker/meetings — send the bot to a meeting.
  if (path === '/api/notetaker/meetings' && request.method === 'POST') {
    if (!auth.userId) return err(403, 'user context required');
    const body = (await request.json().catch(() => ({}))) as { meetingUrl?: unknown; title?: unknown };
    const meetingUrl = typeof body.meetingUrl === 'string' ? body.meetingUrl.trim() : '';
    if (!MEET_URL.test(meetingUrl)) {
      return err(400, 'meetingUrl must be a https://meet.google.com/... link');
    }
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;

    const { key } = await mintApiKey(env, auth.tenantId, auth.userId, 'meeting bot (auto)');

    let res: Response;
    try {
      res = await recorder.fetch('http://recorder/recordings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${recorder.secret}` },
        body: JSON.stringify({ meetingUrl, title, apiKey: key }),
      });
    } catch (e) {
      return err(502, `recorder unreachable: ${(e as Error).message}`);
    }
    if (res.status === 429) return err(429, 'recorder is at capacity — try again in a minute');
    if (!res.ok) return err(502, `recorder error: status ${res.status}`);
    const out = (await res.json()) as { sessionId: string; status: string };
    return json({ meeting: { sessionId: out.sessionId, status: out.status } }, { status: 202 });
  }

  // GET /api/notetaker/meetings/:id — proxy bot session status.
  const m = path.match(/^\/api\/notetaker\/meetings\/([A-Za-z0-9-]+)$/);
  if (m && request.method === 'GET') {
    let res: Response;
    try {
      res = await recorder.fetch(`http://recorder/recordings/${m[1]}`, {
        headers: { authorization: `Bearer ${recorder.secret}` },
      });
    } catch (e) {
      return err(502, `recorder unreachable: ${(e as Error).message}`);
    }
    if (res.status === 404) return err(404, 'meeting session not found');
    if (!res.ok) return err(502, `recorder error: status ${res.status}`);
    return json({ meeting: await res.json() });
  }

  return err(404, 'not found');
}
