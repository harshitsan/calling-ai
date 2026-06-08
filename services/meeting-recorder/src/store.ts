import Database from 'better-sqlite3';
import type { Session } from './types';

const TERMINAL = ['done', 'failed'];

export class SessionStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, meeting_url TEXT, title TEXT, status TEXT,
      reason TEXT, created_at INTEGER, updated_at INTEGER)`);
  }

  upsert(s: Session): void {
    this.db.prepare(`INSERT INTO sessions (id, meeting_url, title, status, reason, created_at, updated_at)
      VALUES (@id, @meetingUrl, @title, @status, @reason, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET status=@status, reason=@reason, updated_at=@updatedAt`).run(s);
  }

  get(id: string): Session | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string, meetingUrl: r.meeting_url as string, title: (r.title as string) ?? null,
      status: r.status as Session['status'], reason: (r.reason as string) ?? null,
      createdAt: r.created_at as number, updatedAt: r.updated_at as number,
    };
  }

  markInterrupted(now: number): void {
    this.db.prepare(`UPDATE sessions SET status='failed', reason='interrupted', updated_at=?
      WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')})`).run(now, ...TERMINAL);
  }
}
