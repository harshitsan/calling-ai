# Meeting participant tracking & speaker diarization

**Date:** 2026-06-17
**Branch:** feat/meeting-recorder

## Problem

The recorder bot leaves any meeting after ~2 minutes and never captures who
attended or who spoke. Root cause: `readParticipantCount` counts
`[data-participant-id]` tiles, a selector that does not match real Google Meet
DOM, so it returns `0`. The runner computes `others = 0 - 1 = -1 (<= 0)`, starts
the "alone" timer at join, and `decideEnd` fires `reason: 'alone'` after
`aloneGraceMs` (default 2 min). An unread DOM is wrongly treated as "empty room."

## Goal

1. Keep the bot in the call reliably.
2. Capture the participant roster (real names).
3. Capture a who-spoke-when timeline.
4. Wire that into the notetaker so the final transcript/notes carry **real
   names per speaker**, not `Speaker 0/1/2`.

Keep it **platform-agnostic**: only Google Meet today, but Teams/Zoom later
should be a new `Platform` entry, not a cross-cutting rewrite.

## Architecture

### Platform abstraction (recorder)

A `Platform` object bundles everything platform-specific:

```ts
interface Platform {
  id: 'google-meet';            // future: 'teams' | 'zoom'
  selectors: Selectors;         // extended (below)
}
detectPlatform(url): Platform   // today: always Google Meet
```

`Selectors` gains:
- `peopleButton`   — opens the participants panel
- `panelParticipantName` — name element per participant row in the panel
- `activeSpeakerIndicator` — element present on a row whose participant is
  currently speaking (resolved to the row's name)

`bot-driver.ts`, `participant-tracker.ts`, and `runner.ts` all depend on
`Platform`/`Selectors`, never on Meet directly.

### Liveness — fail-safe alone detection (fixes the early leave)

- Participant count is derived from the panel **roster** read by the tracker,
  not the tile selector.
- The "alone" timer only runs on a **confident** empty-room reading. If a roster
  read fails or is unavailable, the signal is treated as unknown and the alone
  timer is **not** started. The bot then only ends on `removed`, `stopped`, or
  `max_duration`. Selector drift can never again cause a silent early leave.

### Participant tracker (recorder, in-page JS)

New module `participant-tracker.ts`. After join, clicks the People button once,
then polls ~every 1s via `page.evaluate`:
- **roster**: all `panelParticipantName` texts (deduped, bot excluded) → count + names.
- **active speakers**: rows with `activeSpeakerIndicator` → names speaking now.
- **timeline**: append `{ tMs, speaking: string[] }` where `tMs` is relative to
  `recorder.start()` (aligns with Deepgram audio timestamps).
On stop: coalesce consecutive identical samples into segments
`{ startMs, endMs, name }`.

Outputs `participants: string[]` and `speakerTimeline: Segment[]`.

Selectors for the panel name + speaking indicator are **best-guess + verified
once** via an extended `scripts/probe-participants.ts` against a live meeting.
The fail-safe liveness means wrong selectors degrade gracefully (bot stays, no
names) rather than regressing the leave bug.

### Carrying data to the notetaker

- `uploader.ts` adds form fields `participants` (JSON) and `speakerTimeline` (JSON).
- `POST /api/notetaker` accepts them; one migration adds `participants_json`
  and `speaker_timeline_json` columns to `notetaker_jobs`.

### Alignment → real speakerMap (notetaker)

After Deepgram diarization, before the notes LLM:
- For each Deepgram speaker index, find which timeline segment-name overlaps that
  index's word time the most (max-overlap vote) → deterministic
  `speakerMap = { "0": "Alex", "1": "Mira" }`.
- Feed `speakerMap` + roster into the notes prompt as **ground truth** and render
  `[Alex]`/`[Mira]` labels. Indices with no timeline overlap fall back to the
  existing content-based LLM guess.

## Testing

- Extend `fake-meet.html` with a People panel + speaking indicator and
  `__setRoster` / `__setSpeaking` hooks → unit-test the tracker without real Meet.
- Unit-test the alignment function (timeline + Deepgram words → speakerMap) in
  the worker with fixtures.
- Extend `probe-participants.ts` to dump panel-name + active-speaker DOM.

## Out of scope

- Teams/Zoom implementations (abstraction only).
- Per-utterance confidence scoring beyond max-overlap vote.
```