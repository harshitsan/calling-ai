import type { SessionStatus } from './types';

const NEXT: Record<SessionStatus, SessionStatus[]> = {
  queued: ['joining', 'failed'],
  joining: ['waiting_admit', 'failed'],
  waiting_admit: ['recording', 'failed'],
  recording: ['uploading', 'failed'],
  uploading: ['done', 'failed'],
  done: [],
  failed: [],
};

export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return NEXT[from].includes(to);
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal transition: ${from} -> ${to}`);
  }
}
