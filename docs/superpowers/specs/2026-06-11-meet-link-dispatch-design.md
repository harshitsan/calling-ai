# Dashboard Meet-Link Dispatch — Design

Date: 2026-06-11
Status: approved

## Goal

Paste a Google Meet link in the Calling AI dashboard and have the recorder
bot join, record, and feed the notetaker — an end-to-end test path for the
whole stack, and the seed of the product's "record my meeting" flow.

## Decision

Dashboard → worker → recorder (worker-mediated). The browser never talks to
the recorder; the worker holds the recorder's location and control secret.
For local testing the recorder container is exposed via a cloudflared
tunnel; in production only the RECORDER_URL secret changes.

## Worker

New module `src/worker/meeting-dispatch.ts` (registered before the notetaker
handler in index.ts):

- `POST /api/notetaker/meetings` `{meetingUrl, title?}` — auth required with
  user context (session or api key). Validates the URL is
  `https://meet.google.com/...`. Mints a tenant API key via `mintApiKey()`
  (logic extracted from api-keys.ts; name `meeting bot (auto)`) so the bot's
  upload lands in the caller's tenant. Calls
  `${RECORDER_URL}/recordings` with `authorization: Bearer
  ${RECORDER_CONTROL_SECRET}` and `{meetingUrl, title, apiKey}`.
  Returns `202 {meeting: {sessionId, status}}`.
- `GET /api/notetaker/meetings/:id` — proxies the recorder's
  `GET /recordings/:id` (recorder already redacts the apiKey).
- Errors: 400 non-Meet URL; 503 when RECORDER_URL/RECORDER_CONTROL_SECRET
  unset; 429 passthrough when recorder is at capacity; 502 when the recorder
  is unreachable or errors.

Worker secrets: `RECORDER_URL`, `RECORDER_CONTROL_SECRET`.

## Web UI

On the Notetaker upload page (`NotetakerNew.tsx`), a second card:
"Record a live Google Meet" — link input + Send bot button. After dispatch,
poll `GET /api/notetaker/meetings/:id` every 3s and render the status chain
(`queued → joining → waiting in lobby (admit the bot) → recording →
uploading → done | failed + reason`). On done, point the user at the
Notetaker list where the recording lands as a normal job.

## Key accumulation note

Each dispatch mints one `meeting bot (auto)` key (hash-only storage makes
reuse impossible). Visible/revocable on the API Keys page. Acceptable for
now; auto-cleanup is future work.

## Testing

TDD on meeting-dispatch (mock DB + mocked recorder fetch): happy 202 with
key minted and forwarded, URL validation, missing-config 503, 429
passthrough, fetch-threw 502, GET proxy. Existing suites stay green; web
build verifies the page.

## Out of scope

Recorder hosting automation, per-tenant bot identity, auto-revoking minted
keys, scheduling/calendar integration.
