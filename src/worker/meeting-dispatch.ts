// Meeting dispatch — paste a Google Meet link in the dashboard and the
// recorder bot joins, records, and uploads into the caller's tenant.
//
// The browser never talks to the recorder: this module forwards to it using
// two worker secrets (RECORDER_URL, RECORDER_CONTROL_SECRET) and proxies
// status reads back. Each dispatch mints a tenant API key for the bot's
// upload, so the recording lands in the right account (visible/revocable on
// the API Keys page as "meeting bot (auto)").

import { mintApiKey } from './api-keys';
import { err, json } from './util';

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z0-9?&=_.-]+$/i;

interface RecorderConfig {
  RECORDER_URL?: string;
  RECORDER_CONTROL_SECRET?: string;
}

export async function handleMeetingDispatchApi(
  request: Request,
  env: Env,
  auth: { tenantId: string; userId?: string } | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/notetaker/meetings')) return null;
  if (!auth) return err(401, 'unauthorized');

  const cfg = env as unknown as RecorderConfig;
  const base = (cfg.RECORDER_URL ?? '').replace(/\/$/, '');
  const secret = cfg.RECORDER_CONTROL_SECRET ?? '';
  if (!base || !secret) {
    return err(503, 'recorder not configured: set the RECORDER_URL and RECORDER_CONTROL_SECRET worker secrets');
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
      res = await fetchImpl(`${base}/recordings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
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
      res = await fetchImpl(`${base}/recordings/${m[1]}`, {
        headers: { authorization: `Bearer ${secret}` },
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
