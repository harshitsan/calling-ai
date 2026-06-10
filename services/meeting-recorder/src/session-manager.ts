import type { Session, SessionStatus } from './types';

export interface RunnerContext {
  setStatus: (status: SessionStatus, reason?: string | null) => void;
  isStopRequested: () => boolean;
}

export type Runner = (session: Session, ctx: RunnerContext) => Promise<void>;

export interface SessionManagerOptions {
  maxConcurrent: number;
  runner: Runner;
  idFactory: () => string;
  now: () => number;
  onChange?: (session: Session) => void;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private stopFlags = new Map<string, boolean>();
  private active = 0;

  constructor(private opts: SessionManagerOptions) {}

  activeCount(): number {
    return this.active;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  requestStop(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.stopFlags.set(id, true);
    return true;
  }

  start(meetingUrl: string, title: string | null, apiKey: string | null = null): Session {
    if (this.active >= this.opts.maxConcurrent) {
      throw new Error('at capacity');
    }
    const now = this.opts.now();
    const session: Session = {
      id: this.opts.idFactory(),
      meetingUrl,
      title,
      status: 'queued',
      reason: null,
      createdAt: now,
      updatedAt: now,
      apiKey,
    };
    this.sessions.set(session.id, session);
    this.active++;

    const ctx: RunnerContext = {
      setStatus: (status, reason = null) => {
        session.status = status;
        session.reason = reason;
        session.updatedAt = this.opts.now();
        this.opts.onChange?.(session);
      },
      isStopRequested: () => this.stopFlags.get(session.id) === true,
    };

    this.opts
      .runner(session, ctx)
      .catch((e: unknown) => {
        ctx.setStatus('failed', (e as Error).message);
      })
      .finally(() => {
        this.active--;
        this.stopFlags.delete(session.id);
      });

    this.opts.onChange?.(session);
    return session;
  }
}
