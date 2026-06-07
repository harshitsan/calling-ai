# Meeting Recorder Microservice — Design

**Date:** 2026-06-08
**Status:** Approved (design)
**Author:** harshitsan + Claude

## Summary

A self-hosted microservice that joins a Google Meet as a signed-in participant,
records the meeting **audio**, and uploads it to the existing notetaker pipeline
(`POST /api/notetaker`) for transcription, diarization correction, and notes.

The Cloudflare Worker (the notetaker) is unchanged except for one small,
backward-compatible auth change (see "Notetaker integration").

## Goals

- Join a Google Meet by URL, on demand, and record its audio.
- Hand the recording to the notetaker so it produces transcript + notes.
- Run on infrastructure we control; meeting audio never leaves our systems.

## Non-goals (v1)

- Video / screen recording (audio-only; architecture leaves room for video later).
- Scheduled joins or Google Calendar auto-join (manual "join now" only).
- Joining as an anonymous guest (we use a dedicated signed-in Google account).
- Horizontal scale beyond a single VM (1–2 concurrent meetings to start).
- Crash recovery of in-flight recordings across process/VM restarts.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Build vs buy | **Self-hosted** browser bot | Full control, no per-meeting vendor cost, audio stays in our infra. Accepts ongoing maintenance against Meet changes. |
| Capture scope | **Audio only** | The notetaker only consumes audio. ~30 MB/hr, fits the 100 MB cap, far less CPU/storage. |
| Trigger | **Submit URL, join now** | Simplest; covers the core use case. |
| Bot identity | **Dedicated Google account** | Can join sign-in-required meetings; may be auto-admitted in-org. |
| Runtime | **Single plain VM** running a Node service | Cheapest/simplest to start; we own concurrency + crashes. |
| Concurrency | **1–2** simultaneous, hard cap | Small VM; over cap → HTTP 429. |
| Audio capture method | **PulseAudio virtual sink + ffmpeg** | Industry standard for meeting bots. Captures full mixed audio regardless of WebRTC routing; decoupled from Meet's DOM. |

## Architecture

A new, independent service at `services/meeting-recorder/` in this repo (its own
`package.json`, `Dockerfile`, `tsconfig`). Node + TypeScript + Playwright.
Deployed to the VM via Docker.

### Container makeup (one Docker image)

```
Xvfb (virtual display :99) ─┐
PulseAudio (virtual sink) ──┼─ Chromium (Playwright) ── plays meeting audio → sink
ffmpeg ─────────────────────┘   records sink monitor → /tmp/<id>.mp3
Node service (control API + orchestration)
```

The bot is **two cooperating processes**: Playwright drives the join/admit/leave
UI flow, while ffmpeg independently records the audio sink. If Meet's DOM shifts,
recording keeps working as long as audio is playing.

### Components (each independently testable)

1. **Control API** (Fastify)
   - `POST /recordings { meetingUrl, title? }` → `{ sessionId }`
   - `GET /recordings/:id` → status + reason
   - `POST /recordings/:id/stop` → manual stop
   - `GET /healthz`
   - Protected by a shared bearer secret.
2. **Session manager** — concurrency cap (1–2). Over cap → `429` with
   `Retry-After` (no queue in v1). Owns the per-session state machine.
3. **Bot driver** (Playwright) — loads the persisted Google session
   (storageState), opens the Meet URL, mutes mic+cam, clicks Join, waits for
   admit, watches for end conditions, then leaves.
4. **Audio recorder** — starts ffmpeg on the sink monitor *after admission*,
   stops on end. Independent of Meet's DOM.
5. **Uploader** — POSTs the MP3 to the notetaker (multipart, `x-api-key`) with
   the title.
6. **Auth bootstrap** — a one-time, human-run login that captures the Google
   `storageState` to a mounted secret volume; the bot reuses it. (Google logins
   resist headless automation, so we log in once and persist.)

## Per-session state machine

```
queued → joining → waiting_admit → recording → uploading → done
                ↘ (any failure) ──────────────────────────→ failed (with reason)
```

## Data flow

1. Caller → `POST /recordings { meetingUrl }` → session manager checks cap →
   spawns session.
2. Bot launches Chromium with the persisted Google auth, opens the Meet URL,
   mutes mic/cam, clicks Join.
3. On admission → start ffmpeg recording the sink monitor → `/tmp/<id>.mp3`.
4. Bot watches end conditions (see below).
5. On end → stop ffmpeg, finalize MP3.
6. Uploader POSTs MP3 to the notetaker → notetaker pipeline runs
   (transcribe → speaker-correction → notes).
7. Cleanup: delete local file on success, free the concurrency slot.

## End-of-meeting detection (first to fire wins)

- Bot sees "You've been removed" / "return to home screen".
- **Alone in the call** for N minutes (everyone else left).
- **Hard max-duration cap** (e.g. 2 h).
- Explicit `POST /recordings/:id/stop`.

## Notetaker integration + the one Worker change

The bot authenticates to `POST /api/notetaker` with `x-api-key` (existing
`api_keys` table → tenant). That endpoint currently rejects requests without a
`userId` (`notetaker.ts` POST: `if (!auth.userId) return err(403, ...)`), and
API-key auth returns no `userId` (`api.ts` `authenticate()`).

**Minimal, backward-compatible fix:**

- Add a nullable `user_id` column to `api_keys`.
- `authenticate()` returns it as `userId` when present.
- The meeting-bot's API key is provisioned with a dedicated service user id
  (e.g. `meeting-bot`).
- Existing keys (null `user_id`) keep today's behavior — still 403 on notetaker
  upload. No behavior change for them.

This is the **only** Worker-side change, and it is TDD-able on `authenticate()`.

Uploads use the existing 100 MB cap; audio-only MP3 (~30 MB/hr) stays well under.

## Error handling

| Failure | Handling |
|---|---|
| Invalid/expired Google session | Fail fast → `failed: auth_expired`; surfaces "re-run login bootstrap". |
| Not admitted within lobby timeout (~5 min) | Leave → `failed: not_admitted`. |
| Removed/kicked mid-meeting | Stop ffmpeg, **upload what we captured** (partial is still useful) → `done`. |
| ffmpeg dies | One restart attempt; silence is valid audio, still finalizes. |
| Notetaker upload fails | Retry 3× with backoff; keep MP3 until success; then `failed: upload_failed`, file retained for manual recovery. |
| Process/VM restart mid-session | In-flight sessions lost (v1). Session state persisted to on-disk SQLite so `GET /recordings/:id` reports `failed: interrupted` after restart. |
| Over concurrency cap | `429 Retry-After`. |

## Security

- Control API behind a shared bearer secret; only our systems call it. VM
  firewalled / IP-allowlisted; control API not publicly exposed.
- Google `storageState` + notetaker API key mounted as secrets/volumes — never
  baked into the image or committed.

## Testing strategy

- **Unit (TDD):** state-machine transitions, concurrency limiter, end-condition
  detector, uploader multipart/header construction (mocked fetch), filename/
  format helpers — the pure logic where bugs hide.
- **Bot-flow integration:** run the Playwright driver against a **local
  fake-Meet HTML fixture** mimicking the join/admit/removed DOM — tests
  join/admit/leave logic without real Meet's flakiness.
- **Audio capture:** play a known tone in Chromium → assert ffmpeg produced a
  non-silent MP3 of expected duration.
- **Manual E2E:** bot joins a real test Meet → MP3 appears → notetaker job
  reaches `ready`.

## Open risks

- Google actively fights automated logins/bots; the persisted-session approach
  mitigates but does not eliminate this. A session refresh / re-login runbook is
  required operationally.
- Meet DOM changes will break join/admit/leave selectors over time; the
  audio-capture path is insulated, but the control flow needs occasional
  maintenance.
- Single-VM ceiling: 1–2 concurrent. Beyond that, revisit per-meeting containers.
