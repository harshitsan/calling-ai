# Meeting Recorder Microservice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Node/Playwright microservice that joins a Google Meet as a dedicated Google account, records meeting audio (PulseAudio sink + ffmpeg), and uploads it to the existing notetaker pipeline.

**Architecture:** A standalone service at `services/meeting-recorder/`. Pure logic (state machine, end-detector, session manager, uploader) is TDD'd with no infra. The Playwright bot driver and the ffmpeg recorder take their fragile bits (Meet DOM selectors; audio input source) via injected config, so they're testable against a local fake-Meet HTML fixture and an ffmpeg tone source respectively. A Linux Docker image (Xvfb + PulseAudio + ffmpeg + Chromium) runs it. One small backward-compatible change to the Cloudflare Worker lets an API key carry a service `userId`.

**Tech Stack:** Node 20 + TypeScript (ESM), Fastify 4, Playwright (Chromium), ffmpeg, PulseAudio, Xvfb, better-sqlite3, Vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-06-08-meeting-recorder-design.md`

---

## File Structure

```
services/meeting-recorder/
  package.json            — deps, scripts (dev/test/build/start)
  tsconfig.json           — ESM, strict
  vitest.config.ts        — node environment
  Dockerfile              — playwright base + pulseaudio + ffmpeg
  docker-entrypoint.sh    — start pulseaudio, then node under xvfb
  .dockerignore
  src/
    config.ts             — env → typed Config (pure parse)
    types.ts              — shared types (SessionStatus, Session, etc.)
    state-machine.ts      — allowed status transitions (pure)
    end-detector.ts       — decideEnd() end-of-meeting logic (pure)
    uploader.ts           — uploadRecording() multipart POST + retry (fetch injected)
    session-manager.ts    — concurrency cap + session registry + lifecycle (runner injected)
    store.ts              — SQLite session persistence
    meet-selectors.ts     — production Google Meet selectors (one place)
    bot-driver.ts         — Playwright join/admit/detect-end/leave (selectors injected)
    recorder.ts           — ffmpeg spawn/stop wrapper (input source injected)
    server.ts             — Fastify control API (bearer auth)
    runner.ts             — real session runner: bot-driver + recorder + uploader
    index.ts              — wire config → store → manager → server
  scripts/
    bootstrap-login.ts    — one-time interactive Google login → storageState.json
  test/
    config.test.ts
    state-machine.test.ts
    end-detector.test.ts
    uploader.test.ts
    session-manager.test.ts
    server.test.ts
    recorder.test.ts          — needs ffmpeg on PATH
    bot-driver.test.ts        — Playwright vs fixtures/fake-meet.html
    fixtures/fake-meet.html
```

Worker-side (existing app):
```
migrations/000X_api_keys_user_id.sql   — add nullable user_id column
src/worker/api.ts                       — authenticate() returns userId from api_keys
src/worker/api.test.ts                  — new test for authenticate()
```

---

## Task 1: Scaffold the service package

**Files:**
- Create: `services/meeting-recorder/package.json`
- Create: `services/meeting-recorder/tsconfig.json`
- Create: `services/meeting-recorder/vitest.config.ts`
- Create: `services/meeting-recorder/src/config.ts`
- Test: `services/meeting-recorder/test/config.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "meeting-recorder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "bootstrap-login": "tsx scripts/bootstrap-login.ts"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "playwright": "^1.47.0",
    "better-sqlite3": "^11.3.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "scripts", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 4: Write the failing test** `test/config.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const base = {
    CONTROL_SECRET: 'sek',
    NOTETAKER_URL: 'https://app.example.com',
    NOTETAKER_API_KEY: 'key',
  };

  it('parses required fields and applies defaults', () => {
    const c = loadConfig(base);
    expect(c.controlSecret).toBe('sek');
    expect(c.notetakerUrl).toBe('https://app.example.com');
    expect(c.notetakerApiKey).toBe('key');
    expect(c.port).toBe(8080);
    expect(c.maxConcurrent).toBe(2);
    expect(c.lobbyTimeoutMs).toBe(5 * 60_000);
    expect(c.aloneGraceMs).toBe(2 * 60_000);
    expect(c.maxDurationMs).toBe(2 * 60 * 60_000);
  });

  it('overrides defaults from env', () => {
    const c = loadConfig({ ...base, PORT: '9090', MAX_CONCURRENT: '1' });
    expect(c.port).toBe(9090);
    expect(c.maxConcurrent).toBe(1);
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({ NOTETAKER_URL: 'x', NOTETAKER_API_KEY: 'y' })).toThrow(/CONTROL_SECRET/);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd services/meeting-recorder && npm install && npx vitest run test/config.test.ts`
Expected: FAIL — `loadConfig` is not exported / module not found.

- [ ] **Step 6: Implement `src/config.ts`**

```ts
export interface Config {
  port: number;
  controlSecret: string;
  notetakerUrl: string;
  notetakerApiKey: string;
  maxConcurrent: number;
  lobbyTimeoutMs: number;
  aloneGraceMs: number;
  maxDurationMs: number;
  storageStatePath: string;
  dbPath: string;
  recordingsDir: string;
  audioSink: string;
  botDisplayName: string;
}

function req(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env: ${key}`);
  return v;
}

function num(env: Record<string, string | undefined>, key: string, def: number): number {
  const v = env[key];
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be a number`);
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: num(env, 'PORT', 8080),
    controlSecret: req(env, 'CONTROL_SECRET'),
    notetakerUrl: req(env, 'NOTETAKER_URL'),
    notetakerApiKey: req(env, 'NOTETAKER_API_KEY'),
    maxConcurrent: num(env, 'MAX_CONCURRENT', 2),
    lobbyTimeoutMs: num(env, 'LOBBY_TIMEOUT_MS', 5 * 60_000),
    aloneGraceMs: num(env, 'ALONE_GRACE_MS', 2 * 60_000),
    maxDurationMs: num(env, 'MAX_DURATION_MS', 2 * 60 * 60_000),
    storageStatePath: env.STORAGE_STATE_PATH ?? '/secrets/storageState.json',
    dbPath: env.DB_PATH ?? './data/sessions.db',
    recordingsDir: env.RECORDINGS_DIR ?? './data/recordings',
    audioSink: env.AUDIO_SINK ?? 'meet_sink',
    botDisplayName: env.BOT_DISPLAY_NAME ?? 'Notetaker Bot',
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Create `src/types.ts`**

```ts
export type SessionStatus =
  | 'queued'
  | 'joining'
  | 'waiting_admit'
  | 'recording'
  | 'uploading'
  | 'done'
  | 'failed';

export interface Session {
  id: string;
  meetingUrl: string;
  title: string | null;
  status: SessionStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 9: Commit**

```bash
git add services/meeting-recorder/package.json services/meeting-recorder/tsconfig.json services/meeting-recorder/vitest.config.ts services/meeting-recorder/src/config.ts services/meeting-recorder/src/types.ts services/meeting-recorder/test/config.test.ts
git commit -m "feat(meeting-recorder): scaffold package + typed config"
```

---

## Task 2: Session state machine (pure)

**Files:**
- Create: `services/meeting-recorder/src/state-machine.ts`
- Test: `services/meeting-recorder/test/state-machine.test.ts`

- [ ] **Step 1: Write the failing test** `test/state-machine.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { canTransition, assertTransition } from '../src/state-machine';

describe('state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('queued', 'joining')).toBe(true);
    expect(canTransition('joining', 'waiting_admit')).toBe(true);
    expect(canTransition('waiting_admit', 'recording')).toBe(true);
    expect(canTransition('recording', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'done')).toBe(true);
  });

  it('allows failing from any non-terminal state', () => {
    expect(canTransition('joining', 'failed')).toBe(true);
    expect(canTransition('recording', 'failed')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition('queued', 'recording')).toBe(false);
    expect(canTransition('done', 'recording')).toBe(false);
  });

  it('assertTransition throws on an illegal move', () => {
    expect(() => assertTransition('done', 'recording')).toThrow(/illegal/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/state-machine.ts`**

```ts
import type { SessionStatus } from './types';

const NEXT: Record<SessionStatus, SessionStatus[]> = {
  queued: ['joining', 'failed'],
  joining: ['waiting_admit', 'failed'],
  waiting_admit: ['recording', 'failed'],
  recording: ['uploading', 'failed'],
  uploading: ['done', 'failed'],
  done: [],
  failed: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition: ${from} -> ${to}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state-machine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/state-machine.ts services/meeting-recorder/test/state-machine.test.ts
git commit -m "feat(meeting-recorder): session state machine"
```

---

## Task 3: End-of-meeting detector (pure)

**Files:**
- Create: `services/meeting-recorder/src/end-detector.ts`
- Test: `services/meeting-recorder/test/end-detector.test.ts`

- [ ] **Step 1: Write the failing test** `test/end-detector.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { decideEnd } from '../src/end-detector';

const base = {
  removed: false,
  stopRequested: false,
  otherParticipants: 1,
  aloneSinceMs: null as number | null,
  startedAtMs: 1000,
  nowMs: 1000,
  aloneGraceMs: 120_000,
  maxDurationMs: 7_200_000,
};

describe('decideEnd', () => {
  it('keeps recording when others are present and within limits', () => {
    expect(decideEnd(base)).toEqual({ end: false, reason: null });
  });

  it('ends when the bot was removed', () => {
    expect(decideEnd({ ...base, removed: true })).toEqual({ end: true, reason: 'removed' });
  });

  it('ends on explicit stop request', () => {
    expect(decideEnd({ ...base, stopRequested: true })).toEqual({ end: true, reason: 'stopped' });
  });

  it('ends when alone past the grace window', () => {
    const r = decideEnd({ ...base, otherParticipants: 0, aloneSinceMs: 1000, nowMs: 1000 + 120_001 });
    expect(r).toEqual({ end: true, reason: 'alone' });
  });

  it('keeps recording when alone but still within grace', () => {
    const r = decideEnd({ ...base, otherParticipants: 0, aloneSinceMs: 1000, nowMs: 1000 + 60_000 });
    expect(r.end).toBe(false);
  });

  it('ends when max duration is exceeded', () => {
    const r = decideEnd({ ...base, nowMs: 1000 + 7_200_001 });
    expect(r).toEqual({ end: true, reason: 'max_duration' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/end-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/end-detector.ts`**

```ts
export interface EndInput {
  removed: boolean;
  stopRequested: boolean;
  otherParticipants: number;
  aloneSinceMs: number | null;
  startedAtMs: number;
  nowMs: number;
  aloneGraceMs: number;
  maxDurationMs: number;
}

export interface EndDecision {
  end: boolean;
  reason: 'removed' | 'stopped' | 'alone' | 'max_duration' | null;
}

export function decideEnd(i: EndInput): EndDecision {
  if (i.removed) return { end: true, reason: 'removed' };
  if (i.stopRequested) return { end: true, reason: 'stopped' };
  if (i.nowMs - i.startedAtMs >= i.maxDurationMs) return { end: true, reason: 'max_duration' };
  if (i.otherParticipants <= 0 && i.aloneSinceMs !== null && i.nowMs - i.aloneSinceMs >= i.aloneGraceMs) {
    return { end: true, reason: 'alone' };
  }
  return { end: false, reason: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/end-detector.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/end-detector.ts services/meeting-recorder/test/end-detector.test.ts
git commit -m "feat(meeting-recorder): end-of-meeting detector"
```

---

## Task 4: Uploader (multipart POST + retry, fetch injected)

**Files:**
- Create: `services/meeting-recorder/src/uploader.ts`
- Test: `services/meeting-recorder/test/uploader.test.ts`

- [ ] **Step 1: Write the failing test** `test/uploader.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { uploadRecording } from '../src/uploader';

const opts = {
  notetakerUrl: 'https://app.example.com',
  apiKey: 'secret-key',
  title: 'Standup',
  fileName: 'rec.mp3',
  bytes: new Uint8Array([1, 2, 3]),
  sleep: async () => {},
};

describe('uploadRecording', () => {
  it('POSTs multipart to the notetaker with the api key and title', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ notetaker: { id: 'job1' } }), { status: 201 }));
    const res = await uploadRecording({ ...opts, fetchImpl });
    expect(res.jobId).toBe('job1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://app.example.com/api/notetaker');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'secret-key' });
    const body = (init as RequestInit).body as FormData;
    expect(body.get('title')).toBe('Standup');
    expect(body.get('audio')).toBeInstanceOf(File);
  });

  it('retries on a 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notetaker: { id: 'job2' } }), { status: 201 }));
    const res = await uploadRecording({ ...opts, fetchImpl, maxRetries: 3 });
    expect(res.jobId).toBe('job2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(uploadRecording({ ...opts, fetchImpl, maxRetries: 2 })).rejects.toThrow(/upload failed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/uploader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/uploader.ts`**

```ts
export interface UploadOptions {
  notetakerUrl: string;
  apiKey: string;
  title: string | null;
  fileName: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  jobId: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function uploadRecording(opts: UploadOptions): Promise<UploadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${opts.notetakerUrl.replace(/\/$/, '')}/api/notetaker`;

  let lastErr = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const form = new FormData();
    form.append('audio', new File([opts.bytes], opts.fileName, { type: 'audio/mpeg' }));
    if (opts.title) form.append('title', opts.title);

    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'x-api-key': opts.apiKey }, body: form });
    } catch (e) {
      lastErr = `fetch threw: ${(e as Error).message}`;
      if (attempt < maxRetries) await sleep(attempt * 1000);
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as { notetaker?: { id?: string } };
      const jobId = json.notetaker?.id;
      if (!jobId) throw new Error('upload failed: response missing job id');
      return { jobId };
    }
    lastErr = `status ${res.status}`;
    // Only retry server-side failures; 4xx is a permanent client error.
    if (res.status < 500 || attempt >= maxRetries) break;
    await sleep(attempt * 1000);
  }
  throw new Error(`upload failed: ${lastErr}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/uploader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/uploader.ts services/meeting-recorder/test/uploader.test.ts
git commit -m "feat(meeting-recorder): notetaker uploader with retry"
```

---

## Task 5: Session manager (concurrency cap + registry, runner injected)

**Files:**
- Create: `services/meeting-recorder/src/session-manager.ts`
- Test: `services/meeting-recorder/test/session-manager.test.ts`

The manager owns sessions and enforces the concurrency cap. The work of actually
joining/recording is an injected `runner(session, ctx)` so we test the manager
without any browser. The runner reports status changes through a callback.

- [ ] **Step 1: Write the failing test** `test/session-manager.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session-manager';

function makeManager(maxConcurrent: number, runner: any) {
  let seq = 0;
  return new SessionManager({
    maxConcurrent,
    runner,
    idFactory: () => `s${++seq}`,
    now: () => 1000,
  });
}

describe('SessionManager', () => {
  it('starts a session and exposes it via get', async () => {
    const runner = vi.fn(async () => {});
    const m = makeManager(2, runner);
    const s = m.start('https://meet.example/abc', 'Title');
    expect(s.id).toBe('s1');
    expect(m.get('s1')!.meetingUrl).toBe('https://meet.example/abc');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('rejects when at capacity', async () => {
    // runner that never resolves keeps the slot occupied
    const runner = vi.fn(() => new Promise<void>(() => {}));
    const m = makeManager(1, runner);
    m.start('https://meet.example/a', null);
    expect(() => m.start('https://meet.example/b', null)).toThrow(/at capacity/i);
  });

  it('frees the slot after the runner finishes', async () => {
    let resolve!: () => void;
    const runner = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const m = makeManager(1, runner);
    m.start('https://meet.example/a', null);
    expect(m.activeCount()).toBe(1);
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.activeCount()).toBe(0);
  });

  it('marks a session failed if the runner throws', async () => {
    const runner = vi.fn(async () => { throw new Error('boom'); });
    const m = makeManager(1, runner);
    const s = m.start('https://meet.example/a', null);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.get(s.id)!.status).toBe('failed');
    expect(m.get(s.id)!.reason).toContain('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/session-manager.ts`**

```ts
import type { Session, SessionStatus } from './types';

export interface RunnerContext {
  setStatus: (status: SessionStatus, reason?: string | null) => void;
  isStopRequested: () => boolean;
}

export type Runner = (session: Session, ctx: RunnerContext) => Promise<void>;

export interface SessionManagerOptions {
  maxConcurrent: number;
  runner: Runner;
  idFactory: () => string;
  now: () => number;
  onChange?: (session: Session) => void;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private stopFlags = new Map<string, boolean>();
  private active = 0;

  constructor(private opts: SessionManagerOptions) {}

  activeCount(): number {
    return this.active;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  requestStop(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.stopFlags.set(id, true);
    return true;
  }

  start(meetingUrl: string, title: string | null): Session {
    if (this.active >= this.opts.maxConcurrent) {
      throw new Error('at capacity');
    }
    const now = this.opts.now();
    const session: Session = {
      id: this.opts.idFactory(),
      meetingUrl,
      title,
      status: 'queued',
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.active++;

    const ctx: RunnerContext = {
      setStatus: (status, reason = null) => {
        session.status = status;
        session.reason = reason;
        session.updatedAt = this.opts.now();
        this.opts.onChange?.(session);
      },
      isStopRequested: () => this.stopFlags.get(session.id) === true,
    };

    this.opts
      .runner(session, ctx)
      .catch((e: unknown) => {
        ctx.setStatus('failed', (e as Error).message);
      })
      .finally(() => {
        this.active--;
        this.stopFlags.delete(session.id);
      });

    this.opts.onChange?.(session);
    return session;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/session-manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/session-manager.ts services/meeting-recorder/test/session-manager.test.ts
git commit -m "feat(meeting-recorder): concurrency-capped session manager"
```

---

## Task 6: Control API (Fastify, bearer auth)

**Files:**
- Create: `services/meeting-recorder/src/server.ts`
- Test: `services/meeting-recorder/test/server.test.ts`

- [ ] **Step 1: Write the failing test** `test/server.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server';
import { SessionManager } from '../src/session-manager';

function setup() {
  const manager = new SessionManager({
    maxConcurrent: 2,
    runner: vi.fn(async () => {}),
    idFactory: () => 'sid',
    now: () => 1000,
  });
  const app = buildServer({ manager, controlSecret: 'sek' });
  return { app, manager };
}

describe('control API', () => {
  it('rejects requests without the bearer secret', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/recordings', payload: { meetingUrl: 'https://m/a' } });
    expect(res.statusCode).toBe(401);
  });

  it('starts a recording and returns the session id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/recordings',
      headers: { authorization: 'Bearer sek' },
      payload: { meetingUrl: 'https://m/a', title: 'T' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'sid' });
  });

  it('returns 400 when meetingUrl is missing', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/recordings',
      headers: { authorization: 'Bearer sek' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 429 at capacity', async () => {
    const manager = new SessionManager({
      maxConcurrent: 1,
      runner: () => new Promise<void>(() => {}),
      idFactory: () => 'sid',
      now: () => 1000,
    });
    const app = buildServer({ manager, controlSecret: 'sek' });
    await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/a' } });
    const res = await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/b' } });
    expect(res.statusCode).toBe(429);
  });

  it('GET /recordings/:id returns the session or 404', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/a' } });
    const ok = await app.inject({ method: 'GET', url: '/recordings/sid', headers: { authorization: 'Bearer sek' } });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/recordings/nope', headers: { authorization: 'Bearer sek' } });
    expect(missing.statusCode).toBe(404);
  });

  it('healthz is open and returns ok', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { SessionManager } from './session-manager';

export interface ServerDeps {
  manager: SessionManager;
  controlSecret: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    const authz = req.headers.authorization;
    if (authz !== `Bearer ${deps.controlSecret}`) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/recordings', async (req, reply) => {
    const body = (req.body ?? {}) as { meetingUrl?: unknown; title?: unknown };
    if (typeof body.meetingUrl !== 'string' || !body.meetingUrl) {
      return reply.code(400).send({ error: 'meetingUrl is required' });
    }
    const title = typeof body.title === 'string' ? body.title : null;
    try {
      const session = deps.manager.start(body.meetingUrl, title);
      return reply.code(201).send({ sessionId: session.id, status: session.status });
    } catch (e) {
      if ((e as Error).message === 'at capacity') {
        return reply.code(429).header('retry-after', '60').send({ error: 'at capacity' });
      }
      throw e;
    }
  });

  app.get('/recordings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = deps.manager.get(id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return reply.send(s);
  });

  app.post('/recordings/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deps.manager.requestStop(id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/server.ts services/meeting-recorder/test/server.test.ts
git commit -m "feat(meeting-recorder): Fastify control API with bearer auth"
```

---

## Task 7: ffmpeg recorder wrapper (input source injected)

**Files:**
- Create: `services/meeting-recorder/src/recorder.ts`
- Test: `services/meeting-recorder/test/recorder.test.ts`

The recorder spawns ffmpeg. In production the input is the PulseAudio sink
monitor (`-f pulse -i <sink>.monitor`); in tests we inject ffmpeg's synthetic
sine source (`-f lavfi -i sine=frequency=440:duration=2`) so the wrapper's
spawn/stop/finalize logic is validated with only ffmpeg on PATH — no PulseAudio.

- [ ] **Step 1: Write the failing test** `test/recorder.test.ts`

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/recorder';

function ffmpegAvailable(): boolean {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('Recorder', () => {
  let hasFfmpeg = false;
  beforeAll(() => { hasFfmpeg = ffmpegAvailable(); });

  it('records the injected source to a non-empty mp3 and stops cleanly', async () => {
    if (!hasFfmpeg) { console.warn('ffmpeg not on PATH — skipping'); return; }
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    const out = join(dir, 'test.mp3');
    const rec = new Recorder({
      outputPath: out,
      // Synthetic source for tests; prod injects ['-f','pulse','-i','meet_sink.monitor'].
      inputArgs: ['-f', 'lavfi', '-i', 'sine=frequency=440'],
    });
    rec.start();
    await new Promise((r) => setTimeout(r, 1500));
    await rec.stop();
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(1000);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/recorder.test.ts`
Expected: FAIL — module not found. (If ffmpeg is absent the test self-skips, but it must still fail now on the missing module.)

- [ ] **Step 3: Implement `src/recorder.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';

export interface RecorderOptions {
  outputPath: string;
  inputArgs: string[]; // e.g. ['-f','pulse','-i','meet_sink.monitor']
}

export class Recorder {
  private proc: ChildProcess | null = null;

  constructor(private opts: RecorderOptions) {}

  start(): void {
    if (this.proc) throw new Error('recorder already started');
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...this.opts.inputArgs,
      '-ac', '1',
      '-ar', '16000',
      '-codec:a', 'libmp3lame',
      '-qscale:a', '4',
      '-y',
      this.opts.outputPath,
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
      // 'q' tells ffmpeg to finalize the file gracefully; fall back to SIGINT.
      try { proc.stdin?.write('q'); } catch { /* ignore */ }
      proc.kill('SIGINT');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 5000);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/recorder.test.ts`
Expected: PASS (records ~1.5s of sine to mp3 > 1 KB). If ffmpeg is not installed, install it (`brew install ffmpeg`) and re-run.

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/recorder.ts services/meeting-recorder/test/recorder.test.ts
git commit -m "feat(meeting-recorder): ffmpeg recorder wrapper"
```

---

## Task 8: Bot driver against a fake-Meet fixture (Playwright, selectors injected)

**Files:**
- Create: `services/meeting-recorder/src/meet-selectors.ts`
- Create: `services/meeting-recorder/src/bot-driver.ts`
- Create: `services/meeting-recorder/test/fixtures/fake-meet.html`
- Test: `services/meeting-recorder/test/bot-driver.test.ts`

The driver takes a `Selectors` object so production uses real Meet selectors and
tests use the fixture's. The fixture simulates: a "Join" button, a 300ms lobby,
then an "in-call" view with a participant count element and a "leave" button; a
test hook flips the participant count and a "removed" banner.

- [ ] **Step 1: Create `test/fixtures/fake-meet.html`**

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Fake Meet</title></head>
<body>
  <div id="prejoin">
    <input id="name" placeholder="Your name" />
    <button id="join">Ask to join</button>
  </div>
  <div id="incall" style="display:none">
    <span id="count" data-count="2">2 participants</span>
    <div id="removed" style="display:none">You've been removed from the meeting</div>
    <button id="leave">Leave call</button>
  </div>
  <script>
    document.getElementById('join').addEventListener('click', () => {
      setTimeout(() => {
        document.getElementById('prejoin').style.display = 'none';
        document.getElementById('incall').style.display = 'block';
      }, 300);
    });
    // Test hooks
    window.__setCount = (n) => {
      const el = document.getElementById('count');
      el.setAttribute('data-count', String(n));
      el.textContent = n + ' participants';
    };
    window.__remove = () => { document.getElementById('removed').style.display = 'block'; };
  </script>
</body>
</html>
```

- [ ] **Step 2: Create `src/meet-selectors.ts`**

```ts
export interface Selectors {
  nameInput: string;
  joinButton: string;
  inCallMarker: string;
  participantCount: string; // element whose attribute holds the count
  participantCountAttr: string;
  removedBanner: string;
  leaveButton: string;
}

// Fixture selectors used by tests.
export const FIXTURE_SELECTORS: Selectors = {
  nameInput: '#name',
  joinButton: '#join',
  inCallMarker: '#incall',
  participantCount: '#count',
  participantCountAttr: 'data-count',
  removedBanner: '#removed',
  leaveButton: '#leave',
};

// Best-known Google Meet selectors (2026). Brittle by nature — verify on the
// first real run and adjust here only.
export const MEET_SELECTORS: Selectors = {
  nameInput: 'input[placeholder="Your name"]',
  joinButton: 'button:has-text("Ask to join"), button:has-text("Join now")',
  inCallMarker: 'button[aria-label*="Leave call"]',
  participantCount: 'button[aria-label*="people"]',
  participantCountAttr: 'aria-label',
  removedBanner: 'text=/removed from the meeting|return to home screen/i',
  leaveButton: 'button[aria-label*="Leave call"]',
};
```

- [ ] **Step 3: Write the failing test** `test/bot-driver.test.ts`

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { joinMeeting, isInCall, readParticipantCount, isRemoved } from '../src/bot-driver';
import { FIXTURE_SELECTORS } from '../src/meet-selectors';

const fixtureUrl = pathToFileURL(join(__dirname, 'fixtures', 'fake-meet.html')).href;

describe('bot driver (fixture)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('joins, lands in-call, reads count, and detects removal', async () => {
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await joinMeeting(page, FIXTURE_SELECTORS, 'Notetaker Bot', 5000);
    expect(await isInCall(page, FIXTURE_SELECTORS)).toBe(true);
    expect(await readParticipantCount(page, FIXTURE_SELECTORS)).toBe(2);
    await page.evaluate(() => (window as any).__setCount(1));
    expect(await readParticipantCount(page, FIXTURE_SELECTORS)).toBe(1);
    expect(await isRemoved(page, FIXTURE_SELECTORS)).toBe(false);
    await page.evaluate(() => (window as any).__remove());
    expect(await isRemoved(page, FIXTURE_SELECTORS)).toBe(true);
    await page.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx playwright install chromium && npx vitest run test/bot-driver.test.ts`
Expected: FAIL — module `../src/bot-driver` not found.

- [ ] **Step 5: Implement `src/bot-driver.ts`**

```ts
import type { Page } from 'playwright';
import type { Selectors } from './meet-selectors';

export async function joinMeeting(page: Page, sel: Selectors, displayName: string, lobbyTimeoutMs: number): Promise<void> {
  const nameInput = page.locator(sel.nameInput);
  if (await nameInput.count()) {
    await nameInput.first().fill(displayName).catch(() => {});
  }
  await page.locator(sel.joinButton).first().click();
  await page.waitForSelector(sel.inCallMarker, { timeout: lobbyTimeoutMs });
}

export async function isInCall(page: Page, sel: Selectors): Promise<boolean> {
  return (await page.locator(sel.inCallMarker).count()) > 0
    && await page.locator(sel.inCallMarker).first().isVisible().catch(() => false);
}

export async function readParticipantCount(page: Page, sel: Selectors): Promise<number> {
  const el = page.locator(sel.participantCount).first();
  if (!(await el.count())) return 0;
  const raw = (await el.getAttribute(sel.participantCountAttr)) ?? '';
  const m = raw.match(/\d+/);
  return m ? Number(m[0]) : 0;
}

export async function isRemoved(page: Page, sel: Selectors): Promise<boolean> {
  const el = page.locator(sel.removedBanner).first();
  if (!(await el.count())) return false;
  return el.isVisible().catch(() => false);
}

export async function leaveMeeting(page: Page, sel: Selectors): Promise<void> {
  const btn = page.locator(sel.leaveButton).first();
  if (await btn.count()) await btn.click().catch(() => {});
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/bot-driver.test.ts`
Expected: PASS (joins fixture, reads counts, detects removal).

- [ ] **Step 7: Commit**

```bash
git add services/meeting-recorder/src/meet-selectors.ts services/meeting-recorder/src/bot-driver.ts services/meeting-recorder/test/fixtures/fake-meet.html services/meeting-recorder/test/bot-driver.test.ts
git commit -m "feat(meeting-recorder): Playwright bot driver + fake-Meet fixture"
```

---

## Task 9: SQLite session store

**Files:**
- Create: `services/meeting-recorder/src/store.ts`
- Test: `services/meeting-recorder/test/store.test.ts`

- [ ] **Step 1: Write the failing test** `test/store.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/store';

describe('SessionStore', () => {
  it('upserts and reads back a session', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'recording', reason: null, createdAt: 1, updatedAt: 1 });
    expect(store.get('a')!.status).toBe('recording');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'done', reason: null, createdAt: 1, updatedAt: 2 });
    expect(store.get('a')!.status).toBe('done');
  });

  it('marks interrupted any non-terminal rows (restart recovery)', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'recording', reason: null, createdAt: 1, updatedAt: 1 });
    store.upsert({ id: 'b', meetingUrl: 'u', title: null, status: 'done', reason: null, createdAt: 1, updatedAt: 1 });
    store.markInterrupted(99);
    expect(store.get('a')!.status).toBe('failed');
    expect(store.get('a')!.reason).toBe('interrupted');
    expect(store.get('b')!.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import Database from 'better-sqlite3';
import type { Session } from './types';

const TERMINAL = ['done', 'failed'];

export class SessionStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, meeting_url TEXT, title TEXT, status TEXT,
      reason TEXT, created_at INTEGER, updated_at INTEGER)`);
  }

  upsert(s: Session): void {
    this.db.prepare(`INSERT INTO sessions (id, meeting_url, title, status, reason, created_at, updated_at)
      VALUES (@id, @meetingUrl, @title, @status, @reason, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=@status, reason=@reason, updated_at=@updatedAt`).run(s);
  }

  get(id: string): Session | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, meetingUrl: r.meeting_url as string, title: (r.title as string) ?? null,
      status: r.status as Session['status'], reason: (r.reason as string) ?? null,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }

  markInterrupted(now: number): void {
    this.db.prepare(`UPDATE sessions SET status='failed', reason='interrupted', updated_at=?
      WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')})`).run(now, ...TERMINAL);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/meeting-recorder/src/store.ts services/meeting-recorder/test/store.test.ts
git commit -m "feat(meeting-recorder): SQLite session store with restart recovery"
```

---

## Task 10: Real session runner (wires bot-driver + recorder + uploader)

**Files:**
- Create: `services/meeting-recorder/src/runner.ts`

No unit test: this is the integration glue whose parts are each already tested.
It is exercised by the manual E2E (Task 13). Keep it thin.

- [ ] **Step 1: Implement `src/runner.ts`**

```ts
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Config } from './config';
import type { Runner } from './session-manager';
import { MEET_SELECTORS } from './meet-selectors';
import { joinMeeting, isInCall, readParticipantCount, isRemoved, leaveMeeting } from './bot-driver';
import { Recorder } from './recorder';
import { decideEnd } from './end-detector';
import { uploadRecording } from './uploader';

export function makeRunner(config: Config, now: () => number = () => Date.now()): Runner {
  return async (session, ctx) => {
    mkdirSync(config.recordingsDir, { recursive: true });
    const outputPath = join(config.recordingsDir, `${session.id}.mp3`);
    const browser = await chromium.launchPersistentContext('', {
      headless: false, // headed under Xvfb so audio actually plays
      args: [`--use-fake-ui-for-media-stream`, `--autoplay-policy=no-user-gesture-required`],
      storageState: config.storageStatePath,
    });
    const recorder = new Recorder({ outputPath, inputArgs: ['-f', 'pulse', '-i', `${config.audioSink}.monitor`] });
    const page = await browser.newPage();
    try {
      ctx.setStatus('joining');
      await page.goto(session.meetingUrl, { waitUntil: 'load' });
      ctx.setStatus('waiting_admit');
      await joinMeeting(page, MEET_SELECTORS, config.botDisplayName, config.lobbyTimeoutMs);
      if (!(await isInCall(page, MEET_SELECTORS))) throw new Error('not_admitted');

      ctx.setStatus('recording');
      recorder.start();
      const startedAtMs = now();
      let aloneSinceMs: number | null = null;

      for (;;) {
        await page.waitForTimeout(5000);
        const others = await readParticipantCount(page, MEET_SELECTORS) - 1; // minus the bot
        if (others <= 0) aloneSinceMs ??= now();
        else aloneSinceMs = null;
        const decision = decideEnd({
          removed: await isRemoved(page, MEET_SELECTORS),
          stopRequested: ctx.isStopRequested(),
          otherParticipants: others,
          aloneSinceMs, startedAtMs, nowMs: now(),
          aloneGraceMs: config.aloneGraceMs, maxDurationMs: config.maxDurationMs,
        });
        if (decision.end) { session.reason = decision.reason; break; }
      }

      await recorder.stop();
      await leaveMeeting(page, MEET_SELECTORS).catch(() => {});

      ctx.setStatus('uploading');
      const bytes = readFileSync(outputPath);
      await uploadRecording({
        notetakerUrl: config.notetakerUrl, apiKey: config.notetakerApiKey,
        title: session.title, fileName: `${session.id}.mp3`, bytes: new Uint8Array(bytes),
      });
      ctx.setStatus('done', session.reason);
      rmSync(outputPath, { force: true });
    } finally {
      await recorder.stop().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd services/meeting-recorder && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add services/meeting-recorder/src/runner.ts
git commit -m "feat(meeting-recorder): real session runner wiring bot+recorder+uploader"
```

---

## Task 11: Entry point + login bootstrap script

**Files:**
- Create: `services/meeting-recorder/src/index.ts`
- Create: `services/meeting-recorder/scripts/bootstrap-login.ts`

- [ ] **Step 1: Implement `src/index.ts`**

```ts
import { loadConfig } from './config';
import { SessionStore } from './store';
import { SessionManager } from './session-manager';
import { buildServer } from './server';
import { makeRunner } from './runner';
import { randomUUID } from 'node:crypto';

const config = loadConfig();
const store = new SessionStore(config.dbPath);
store.markInterrupted(Date.now());

const manager = new SessionManager({
  maxConcurrent: config.maxConcurrent,
  runner: makeRunner(config),
  idFactory: () => randomUUID(),
  now: () => Date.now(),
  onChange: (s) => store.upsert(s),
});

const app = buildServer({ manager, controlSecret: config.controlSecret });
app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
  console.log(`[meeting-recorder] listening on :${config.port}`);
});
```

- [ ] **Step 2: Implement `scripts/bootstrap-login.ts`**

```ts
// Run once, interactively, to capture the bot's Google session:
//   xvfb-run -a npx tsx scripts/bootstrap-login.ts   (on the VM, headed)
// Or locally with a visible browser. Sign in fully, solve any challenge, then
// press Enter in the terminal to save storageState.
import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';

const OUT = process.env.STORAGE_STATE_PATH ?? './secrets/storageState.json';

const ctx = await chromium.launchPersistentContext('', { headless: false });
const page = await ctx.newPage();
await page.goto('https://accounts.google.com/');
console.log('Sign in to the bot Google account in the browser window.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter here once you are fully signed in... ');
await ctx.storageState({ path: OUT });
console.log(`Saved storage state to ${OUT}`);
await ctx.close();
process.exit(0);
```

- [ ] **Step 3: Typecheck and smoke-run the server locally**

```bash
cd services/meeting-recorder
npx tsc --noEmit
CONTROL_SECRET=dev NOTETAKER_URL=http://localhost NOTETAKER_API_KEY=x DB_PATH=:memory: npx tsx src/index.ts &
sleep 2
curl -s localhost:8080/healthz
kill %1
```
Expected: `{"ok":true}`.

- [ ] **Step 4: Commit**

```bash
git add services/meeting-recorder/src/index.ts services/meeting-recorder/scripts/bootstrap-login.ts
git commit -m "feat(meeting-recorder): entrypoint + Google login bootstrap script"
```

---

## Task 12: Worker auth change — API keys can carry a service userId

**Files:**
- Create: `migrations/0007_api_keys_user_id.sql` (use the next free number in `migrations/`)
- Modify: `src/worker/api.ts` (the `authenticate()` function, ~lines 16-31)
- Test: `src/worker/api.test.ts`

- [ ] **Step 1: Inspect existing migrations to pick the next number**

Run: `ls migrations/`
Expected: note the highest-numbered file; name the new one with the next index.

- [ ] **Step 2: Create the migration** `migrations/0007_api_keys_user_id.sql`

```sql
ALTER TABLE api_keys ADD COLUMN user_id TEXT;
```

- [ ] **Step 3: Write the failing test** `src/worker/api.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest';
import { authenticate } from './api';

function envWith(row: { tenant_id: string; user_id: string | null } | null) {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
    JWT_SECRET: 'unused-here',
  } as unknown as Env;
}

describe('authenticate via x-api-key', () => {
  it('returns the service userId when the api key row has one', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith({ tenant_id: 't1', user_id: 'meeting-bot' }));
    expect(auth).toEqual({ tenantId: 't1', userId: 'meeting-bot' });
  });

  it('returns tenant with undefined userId when user_id is null (back-compat)', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith({ tenant_id: 't1', user_id: null }));
    expect(auth).toEqual({ tenantId: 't1', userId: undefined });
  });

  it('returns null when no key matches', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith(null));
    expect(auth).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/worker/api.test.ts`
Expected: FAIL — current code selects only `tenant_id` and returns `{ tenantId }`, so `userId` is missing.

- [ ] **Step 5: Update `authenticate()` in `src/worker/api.ts`**

Replace the `x-api-key` branch (the block selecting `tenant_id`) with:

```ts
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    const hash = await hashApiKey(apiKey);
    const row = await env.DB.prepare('SELECT tenant_id, user_id FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ tenant_id: string; user_id: string | null }>();
    if (row) return { tenantId: row.tenant_id, userId: row.user_id ?? undefined };
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/worker/api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Apply the migration and provision the bot key**

```bash
# Apply migration to remote D1
npx wrangler d1 migrations apply calling-ai-db --remote
# Provision a bot API key (generate a strong key, store its hash). Example:
#   KEY=$(openssl rand -hex 24)
#   compute hash the same way hashApiKey does (SHA-256, base64url) and insert:
#   INSERT INTO api_keys (key_hash, tenant_id, user_id) VALUES ('<hash>', '<tenant>', 'meeting-bot');
# Keep KEY as the meeting-recorder's NOTETAKER_API_KEY secret.
```

- [ ] **Step 8: Commit**

```bash
git add migrations/0007_api_keys_user_id.sql src/worker/api.ts src/worker/api.test.ts
git commit -m "feat(worker): api keys can carry a service userId for bot uploads"
```

---

## Task 13: Containerize + local run + manual E2E

**Files:**
- Create: `services/meeting-recorder/Dockerfile`
- Create: `services/meeting-recorder/docker-entrypoint.sh`
- Create: `services/meeting-recorder/.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
data
secrets
```

- [ ] **Step 2: Create `docker-entrypoint.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Start a virtual display and a virtual audio sink, then run the service.
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
pulseaudio --start --exit-idle-time=-1 --disallow-exit
pactl load-module module-null-sink sink_name="${AUDIO_SINK:-meet_sink}" sink_properties=device.description=meet_sink
pactl set-default-sink "${AUDIO_SINK:-meet_sink}"
exec node dist/index.js
```

- [ ] **Step 3: Create `Dockerfile`**

```dockerfile
# Playwright base ships Chromium + all browser system deps.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
    pulseaudio pulseaudio-utils ffmpeg xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript && npx tsc -p tsconfig.json

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DISPLAY=:99
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

- [ ] **Step 4: Build the image and run healthz locally (Docker Desktop)**

```bash
cd services/meeting-recorder
docker build -t meeting-recorder .
docker run --rm -p 8080:8080 \
  -e CONTROL_SECRET=dev -e NOTETAKER_URL=https://calling-ai.polished-mud-fefe.workers.dev \
  -e NOTETAKER_API_KEY=<bot-key> \
  -e DB_PATH=/app/data/sessions.db \
  -v "$PWD/secrets:/secrets:ro" \
  --name mr meeting-recorder &
sleep 5
curl -s localhost:8080/healthz
```
Expected: `{"ok":true}`.

- [ ] **Step 5: Capture the bot's Google session (one-time)**

On a machine with a display (or via the container with a forwarded display), run
`npm run bootstrap-login`, sign in to the dedicated bot Google account, press
Enter. Copy the resulting `storageState.json` into `services/meeting-recorder/secrets/`
so the container mounts it at `/secrets/storageState.json`.

- [ ] **Step 6: Manual end-to-end**

```bash
# With the container running and storageState mounted, start a real meeting and:
curl -s -X POST localhost:8080/recordings \
  -H 'authorization: Bearer dev' -H 'content-type: application/json' \
  -d '{"meetingUrl":"https://meet.google.com/xxx-yyyy-zzz","title":"E2E test"}'
# → {"sessionId":"...","status":"queued"}
# Admit the bot from the host. Let it run ~1 min, then end the meeting (or POST /stop).
curl -s localhost:8080/recordings/<sessionId> -H 'authorization: Bearer dev'
# → status should progress to 'uploading' then 'done'.
```
Expected: a notetaker job appears (check the notetaker UI / `GET /api/notetaker`) and reaches `ready` with a transcript. Verify the recorded audio is intelligible. If join/admit selectors fail, adjust `MEET_SELECTORS` in `src/meet-selectors.ts` and rebuild.

- [ ] **Step 7: Commit**

```bash
git add services/meeting-recorder/Dockerfile services/meeting-recorder/docker-entrypoint.sh services/meeting-recorder/.dockerignore
git commit -m "feat(meeting-recorder): Dockerfile + entrypoint (Xvfb + PulseAudio + ffmpeg)"
```

---

## Self-Review

**Spec coverage:**
- Self-hosted browser bot → Tasks 8, 10, 13. ✓
- Audio-only via PulseAudio + ffmpeg → Tasks 7, 10, 13 (entrypoint sink). ✓
- Submit-URL-join-now control API → Task 6. ✓
- Dedicated Google account / persisted session → Tasks 10 (storageState), 11 (bootstrap). ✓
- Single VM, 1-2 concurrent, 429 over cap → Tasks 5, 6. ✓
- End detection (removed/alone/max/stop) → Tasks 3, 10. ✓
- Notetaker integration + `api_keys.user_id` change → Tasks 4, 12. ✓
- Error handling (not_admitted, partial upload on removal, upload retry, interrupted recovery) → Tasks 4 (retry), 9 (interrupted), 10 (not_admitted/partial), 3 (reasons). ✓
- Security (bearer secret, mounted secrets) → Tasks 6, 13. ✓
- Testing strategy (unit pure logic, fixture bot-flow, audio tone, manual E2E) → Tasks 2-9, 13. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. Meet selectors in Task 8 are concrete starting values explicitly flagged for first-run verification (inherent to scraping, not a placeholder).

**Type consistency:** `Session`/`SessionStatus` (types.ts) used consistently across store, manager, server, runner. `Runner`/`RunnerContext` signatures match between Task 5 (definition) and Task 10 (implementation). `Selectors` shape matches between meet-selectors.ts and bot-driver.ts. `uploadRecording` options match between Task 4 and Task 10's call. `Recorder` constructor `{outputPath, inputArgs}` matches Tasks 7 and 10.

**Note on partial-upload-on-removal:** Task 10's loop sets `session.reason` and breaks on `removed`; `recorder.stop()` finalizes the file before upload, so a kicked bot still uploads captured audio. ✓
