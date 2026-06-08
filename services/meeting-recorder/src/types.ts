export type SessionStatus =
  | 'queued'
  | 'joining'
  | 'waiting_admit'
  | 'recording'
  | 'uploading'
  | 'done'
  | 'failed';

export interface Session {
  id: string;
  meetingUrl: string;
  title: string | null;
  status: SessionStatus;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
