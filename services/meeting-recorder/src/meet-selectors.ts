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
