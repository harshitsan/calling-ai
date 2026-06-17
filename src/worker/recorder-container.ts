// Cloudflare Container hosting the meeting-recorder bot (services/meeting-recorder).
// One instance ("main", see meeting-dispatch.ts) multiplexes recording
// sessions; requests reach it only through the RECORDER binding — it has no
// public URL.

import { Container } from '@cloudflare/containers';

interface RecorderSecrets {
  RECORDER_CONTROL_SECRET?: string;
  PUBLIC_BASE_URL?: string;
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
    return {
      CONTROL_SECRET: secret,
      NOTETAKER_URL: base,
      // Uploads use per-dispatch tenant keys; the global fallback stays unset
      // on purpose so an upload without a tenant key fails loudly.
      NOTETAKER_API_KEY: 'tenant-keys-only',
      // docker-entrypoint.sh downloads the bot's Google session from here at
      // boot (served out of R2 by the worker, gated on CONTROL_SECRET).
      STORAGE_STATE_URL: `${base}/internal/recorder/storage-state`,
      DB_PATH: '/app/data/sessions.db',
    };
  })();
}
