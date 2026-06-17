export interface Selectors {
  nameInput: string;
  joinButton: string;
  // Shown instead of the join button when the bot's account is already in the
  // call from another session (e.g. the account owner, or a crashed bot).
  alreadyInCallButton: string;
  inCallMarker: string;
  // One element per participant (incl. the bot itself); the count of matches is
  // the participant count. Meet's "People N" toolbar label lives in an overflow
  // that appears/disappears with window size, so counting tiles is far more
  // robust than parsing a label — see scripts/probe-participants.ts.
  // DEPRECATED for liveness: the participant tracker derives the count from the
  // People-panel roster instead (a tile selector that silently stops matching
  // is exactly what caused the false "alone" early-leave). Kept for the probe.
  participantTile: string;
  removedBanner: string;
  leaveButton: string;
  // --- Participants panel (roster + who's speaking) ---
  // Toolbar button that opens the People/participants panel.
  peopleButton: string;
  // One element per participant row inside the open panel (incl. the bot).
  participantRow: string;
  // Name element relative to a participantRow. Empty string => use the row's
  // own trimmed textContent as the name.
  participantName: string;
  // Element that exists/matches inside a participantRow ONLY while that
  // participant is actively speaking (Meet's animated speaking indicator).
  speakingIndicator: string;
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
  peopleButton: '#people',
  participantRow: '#panel .prow',
  participantName: '.pname',
  speakingIndicator: '.speaking',
};

// Best-known Google Meet selectors (2026). Brittle by nature — the panel
// roster/name/speaking selectors below are BEST-GUESS and must be confirmed on
// the first real run via scripts/probe-participants.ts, then corrected here.
export const MEET_SELECTORS: Selectors = {
  nameInput: 'input[placeholder="Your name"]',
  joinButton: 'button:has-text("Ask to join"), button:has-text("Join now")',
  alreadyInCallButton: 'button:has-text("Switch here")',
  inCallMarker: 'button[aria-label*="Leave call"]',
  participantTile: '[data-participant-id]',
  removedBanner: 'text=/removed from the meeting|return to home screen/i',
  leaveButton: 'button[aria-label*="Leave call"]',
  peopleButton: 'button[aria-label*="People" i], button[aria-label*="Show everyone" i]',
  // Panel rows: Meet renders each participant as a role=listitem carrying a
  // data-participant-id. Confirm via probe.
  participantRow: '[role="list"] [role="listitem"][data-participant-id], [aria-label="Participants"] [role="listitem"]',
  // Name lives in a dedicated span within the row; fall back to row text if the
  // probe shows otherwise.
  participantName: 'span[jsname], [data-self-name]',
  // Meet toggles a "speaking" animation; the indicator carries an aria-label
  // mentioning "speaking" / "presenting" while active. Confirm via probe.
  speakingIndicator: '[aria-label*="speaking" i], [class*="speaking" i]',
};
