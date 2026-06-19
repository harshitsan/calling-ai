// Pure decision helpers for the "are we alone?" signal that drives the leave
// timer. Kept out of the runner so the gating logic is unit-testable without a
// live browser.
//
// Strategy: the free DOM tile count is a cheap pre-filter; an OpenAI vision
// check is the authoritative confirmer. We only spend a vision call when the
// DOM suggests we might be alone (just the bot's own tile) or when the DOM has
// gone unreadable for several polls — so populated meetings cost nothing.

// Minimum gap between vision calls, so the 5s poll loop can't spam the API while
// the alone-grace window counts down. Well inside the default 2-minute grace.
export const VISION_MIN_INTERVAL_MS = 15_000;

// How many consecutive unreadable DOM polls before we vision-check anyway (so a
// fully drifted/broken roster can still trigger a leave instead of hanging).
export const BLIND_POLLS_BEFORE_VISION = 3;

export interface VisionGateInput {
  visionConfigured: boolean;
  // Total participant tiles the DOM probe saw THIS poll, INCLUDING the bot's own
  // tile. `null` when the roster couldn't be read at all.
  domTotal: number | null;
  // Consecutive unreadable DOM polls, counting this one.
  unreadStreak: number;
  msSinceLastVision: number;
  minIntervalMs?: number;
}

/** Whether to spend a vision call on this poll. */
export function shouldRunVision(p: VisionGateInput): boolean {
  if (!p.visionConfigured) return false;
  const maybeAlone = p.domTotal !== null && p.domTotal <= 1; // only the bot's tile
  const blindTooLong = p.domTotal === null && p.unreadStreak >= BLIND_POLLS_BEFORE_VISION;
  if (!maybeAlone && !blindTooLong) return false;
  return p.msSinceLastVision >= (p.minIntervalMs ?? VISION_MIN_INTERVAL_MS);
}

export interface LeaveOthersInput {
  visionConfigured: boolean;
  ranVision: boolean;
  // Result of the vision call this poll (only meaningful when ranVision).
  visionOthers: number | null;
  // DOM tile count incl. the bot, or null if unreadable.
  domTotal: number | null;
}

/**
 * Resolve the count of OTHER participants for the leave decision.
 *
 * Returns `null` for "unknown" — the caller must then leave the alone-timer
 * untouched (neither start nor reset it), matching the DOM fail-safe.
 *
 * Note the DOM fallback uses `domTotal - 1` (subtract the bot's own ever-present
 * tile) rather than name-based self-exclusion, so it's correct regardless of
 * what the bot is named in Meet — the original bug was name-based filtering
 * counting the bot as a stranger.
 */
export function resolveLeaveOthers(p: LeaveOthersInput): number | null {
  if (p.ranVision) return p.visionOthers; // vision is authoritative when we ran it
  if (!p.visionConfigured) {
    return p.domTotal === null ? null : Math.max(0, p.domTotal - 1);
  }
  // Vision is configured but we didn't call it this poll:
  if (p.domTotal !== null && p.domTotal > 1) return p.domTotal - 1; // clearly populated — cheap reset
  return null; // maybe-alone, between vision calls — keep the timer as-is
}
