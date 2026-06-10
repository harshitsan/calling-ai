# Notetaker API Gateway — Design

Date: 2026-06-10
Status: approved

## Goal

Let any organization send meeting recordings to the notetaker pipeline via a
self-serve public API: sign up in the web app, create an API key, POST audio,
receive structured notes via webhook (or polling).

## Requirements (from brainstorming)

- Self-serve onboarding: org registers via existing `/api/auth/register`,
  manages API keys from a new "API Keys" page in the web app.
- Async ingestion: upload returns `202` immediately; a webhook fires when
  notes are ready (or the job fails). Polling endpoints remain available.
- Direct multipart file upload only (no fetch-from-URL in v1).
- No quotas/rate limits/billing in v1.
- Async runner: **Cloudflare Queues** (Workers Paid plan is available).
  Durable-Object alarms were considered but Queues gives retries + DLQ
  semantics with less custom code. `ctx.waitUntil` is ruled out — this
  codebase already observed it dying mid-execution (see notetaker.ts).

## Architecture

One new queue `notetaker-jobs`; the same worker is producer and consumer
(`queue()` handler exported next to `fetch()`).

```
org POST /api/v1/notetaker (x-api-key, multipart)
  → validate → audio to R2 → job row status='queued' (+ webhook_url)
  → NOTETAKER_QUEUE.send({ kind:'process', jobId, tenantId })
  → 202 { notetaker: { id, status:'queued', ... } }

queue consumer:
  kind='process' → processJob() (Deepgram → notes LLM)
                 → if webhook_url set: send({ kind:'webhook', jobId, tenantId })
  kind='webhook' → POST signed payload to webhook_url; throw on non-2xx
                 → Queues retries w/ backoff (max 5), then webhook_status='failed'
```

- `processJob` gains an idempotency guard: skip if the job is already
  `ready`/`failed` so queue redelivery cannot double-process.
- Processing messages: `max_retries: 3`. Webhook messages: `max_retries: 5`.
  Final failure marks the job `failed` / `webhook_status='failed'`.
- The web app's upload switches to the same async path (the detail page
  already polls). The meeting-recorder uploader only checks `res.ok` and the
  job id, so `202` keeps it working unchanged.

## Public API (auth: `x-api-key`)

- `POST /api/v1/notetaker` — multipart `audio` (≤100 MB), optional `title`,
  optional `webhookUrl` (must be `https://`) → `202 { notetaker }`
- `GET /api/v1/notetaker/:id` — job status / notes
- `GET /api/v1/notetaker` — list jobs
- `GET /api/v1/notetaker/:id/audio` — original audio

`/api/v1/notetaker*` is a thin alias to the existing `/api/notetaker`
handlers (path normalization), so web app and public API share one code path.

## Webhook contract

```
POST <webhookUrl>
content-type: application/json
X-Notetaker-Signature: sha256=<hex HMAC-SHA256 of raw body>
X-Notetaker-Delivery: <uuid>

{ "event": "notetaker.ready" | "notetaker.failed", "notetaker": { ...job json } }
```

Signed with the tenant's webhook secret (generated on first key creation,
shown on the API Keys page).

## Key management API (auth: JWT session only — not api keys)

- `POST /api/api-keys { name }` → `{ id, name, key, prefix, createdAt }` —
  full key returned exactly once; only SHA-256 hash + prefix stored.
- `GET /api/api-keys` → list `{ id, name, prefix, createdAt }`
- `DELETE /api/api-keys/:id` → revoke

Created keys carry the creating user's id (`api_keys.user_id`, migration
0013), which satisfies the notetaker's user-context requirement for uploads.

## Schema changes

- `0014_notetaker_webhooks.sql`: `ALTER TABLE notetaker_jobs ADD COLUMN
  webhook_url TEXT; ADD COLUMN webhook_status TEXT; ADD COLUMN
  webhook_attempts INTEGER DEFAULT 0;`
- `0015_tenant_webhook_secret.sql`: `ALTER TABLE tenants ADD COLUMN
  webhook_secret TEXT;`
- (`0013_api_keys_user_id.sql` already exists on this branch.)

## Web UI

New **API Keys** page (existing page style): list keys (name, prefix,
created), create key (modal shows the key once + copy button), revoke,
webhook signing secret display, and a curl quick-start snippet.

## Config

`wrangler.jsonc`: queue producer binding `NOTETAKER_QUEUE` → `notetaker-jobs`;
consumer config `max_retries`, `max_batch_size: 1`.

## Error handling

- Invalid uploads (mime/size/empty/bad webhookUrl) → existing 4xx errors,
  nothing enqueued, nothing stored.
- Transcription/LLM failure → job `failed` with error text; failure webhook
  still fires.
- Webhook endpoint down → 5 signed attempts with backoff →
  `webhook_status='failed'`; job stays pollable.

## Testing

Vitest, existing mock-env style (`notetaker.test.ts`, `api.test.ts`):

- key CRUD: create returns full key once, stores hash+prefix+user_id;
  list/revoke; api-key auth rejected on key-management routes.
- upload: 202 + row queued + message enqueued (mock queue binding);
  webhookUrl validation.
- consumer: process message runs pipeline; idempotency on redelivery;
  webhook message signs correctly (HMAC verified in test) and throws on
  non-2xx so Queues retries.
- v1 alias routes hit the same handlers.

## Out of scope (v1)

Quotas, rate limiting, usage dashboards, billing, fetch-from-URL ingestion,
per-key webhook secrets/rotation.
