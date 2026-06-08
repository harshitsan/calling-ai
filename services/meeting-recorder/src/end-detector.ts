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
