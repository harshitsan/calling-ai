export interface Selectors {
  nameInput: string;
  joinButton: string;
  // Shown instead of the join button when the bot's account is already in the
  // call from another session (e.g. the account owner, or a crashed bot).
  alreadyInCallButton: string;
  inCallMarker: string;
  // One element per participant (incl. the bot itself). DEPRECATED for liveness
  // and roster: the participant tracker now auto-discovers both via the in-page
  // probe (src/participant-probe.ts), which is resilient to Meet's DOM drift —
  // a fixed tile selector that silently stopped matching is exactly what caused
  // the false "alone" early-leave. Kept only as a coarse diagnostic.
  participantTile: string;
  removedBanner: string;
  leaveButton: string;
}

// Fixture selectors used by tests.
export const FIXTURE_SELECTORS: Selectors = {
  nameInput: '#name',
  joinButton: '#join',
  alreadyInCallButton: '#switch',
  inCallMarker: '#incall',
  participantTile: '[data-participant-id]',
  removedBanner: '#removed',
  leaveButton: '#leave',
};

// Best-known Google Meet selectors (2026). Brittle by nature — verify on the
// first real run and adjust here only. The participants roster + who's-speaking
// detection is NOT here: it's auto-discovered at runtime by the in-page probe.
export const MEET_SELECTORS: Selectors = {
  nameInput: 'input[placeholder="Your name"]',
  joinButton: 'button:has-text("Ask to join"), button:has-text("Join now")',
  alreadyInCallButton: 'button:has-text("Switch here")',
  inCallMarker: 'button[aria-label*="Leave call"]',
  participantTile: '[data-participant-id]',
  removedBanner: 'text=/removed from the meeting|return to home screen/i',
  leaveButton: 'button[aria-label*="Leave call"]',
};
