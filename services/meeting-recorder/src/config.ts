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
  if (v === undefined || v === '') return def;
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
