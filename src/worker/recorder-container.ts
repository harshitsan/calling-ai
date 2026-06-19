// Cloudflare Container hosting the meeting-recorder bot (services/meeting-recorder).
// One instance ("main", see meeting-dispatch.ts) multiplexes recording
// sessions; requests reach it only through the RECORDER binding — it has no
// public URL.

import { Container } from '@cloudflare/containers';

interface RecorderSecrets {
  RECORDER_CONTROL_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  // Reused for the recorder's vision liveness check (see services/meeting-recorder
  // src/liveness-vision.ts). Already a worker secret for voice/notetaker.
  OPENAI_API_KEY?: string;
  VISION_MODEL?: string;
  BOT_DISPLAY_NAME?: string;
}

export class RecorderContainer extends Container<Env> {
  defaultPort = 8080;
  // Must outlast the longest recording (MAX_DURATION_MS defaults to 2h):
  // sleepAfter is measured from the last request, and during an active
  // recording the only requests are the dashboard's status polls — which stop
  // if the user closes the tab.
  sleepAfter = '3h';

  envVars = ((): Record<string, string> => {
    const env = this.env as unknown as RecorderSecrets;
    const base = env.PUBLIC_BASE_URL ?? 'https://calling-ai.polished-mud-fefe.workers.dev';
    const secret = env.RECORDER_CONTROL_SECRET ?? '';
    const vars: Record<string, string> = {
      CONTROL_SECRET: secret,
      NOTETAKER_URL: base,
      // Uploads use per-dispatch tenant keys; the global fallback stays unset
      // on purpose so an upload without a tenant key fails loudly.
      NOTETAKER_API_KEY: 'tenant-keys-only',
      // docker-entrypoint.sh downloads the bot's Google session from here at
      // boot (served out of R2 by the worker, gated on CONTROL_SECRET).
      STORAGE_STATE_URL: `${base}/internal/recorder/storage-state`,
      DB_PATH: '/app/data/sessions.db',
      // The bot joins via its Google session, so its Meet name is the account
      // name (not the old 'Notetaker Bot' default). This excludes the bot from
      // the diarization roster and tells the vision check which tile is its own.
      BOT_DISPLAY_NAME: env.BOT_DISPLAY_NAME ?? 'dev gomagentic',
    };
    // Vision liveness check, so the bot leaves once everyone else has left.
    // Reuses the worker's existing OPENAI_API_KEY secret; when absent the
    // recorder falls back to a name-independent DOM tile count.
    if (env.OPENAI_API_KEY) vars.OPENAI_API_KEY = env.OPENAI_API_KEY;
    if (env.VISION_MODEL) vars.VISION_MODEL = env.VISION_MODEL;
    return vars;
  })();
}
