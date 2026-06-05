// Feature flags — flip these to hide modules from the dashboard without
// touching their source files. Server-side counterparts live next to the
// feature (e.g. VOICEOVERS_ENABLED in src/worker/voiceovers.ts) so both
// halves must be flipped together to fully disable a feature.

export const VOICEOVERS_ENABLED = true;
export const VOICE_INTEGRATIONS_ENABLED = true;
export const NOTETAKER_ENABLED = true;
