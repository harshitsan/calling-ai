import { MEET_SELECTORS, type Selectors } from './meet-selectors';

// A meeting platform bundles everything platform-specific: the DOM selectors
// and (later) any join/leave quirks. Today only Google Meet is implemented;
// adding Teams/Zoom is a new entry here + its own selectors, not edits spread
// across the runner, bot-driver, and participant tracker.
export type PlatformId = 'google-meet';

export interface Platform {
  id: PlatformId;
  selectors: Selectors;
}

export const GOOGLE_MEET: Platform = {
  id: 'google-meet',
  selectors: MEET_SELECTORS,
};

// Pick the platform from a meeting URL. The single extension point for new
// platforms — everything downstream consumes the returned Platform.
export function detectPlatform(url: string): Platform {
  // Future: if (/teams\.microsoft\.com/.test(url)) return MICROSOFT_TEAMS;
  return GOOGLE_MEET;
}
