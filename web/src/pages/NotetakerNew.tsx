import { ArrowLeft, FileAudio, Loader2, Sparkles, UploadCloud, Video, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, getToken } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_BYTES = 100 * 1024 * 1024;
const ACCEPTED = '.mp3,.m4a,.wav,.webm,.ogg,.flac,.aac,audio/*';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface BotSession {
  id: string;
  status: 'queued' | 'joining' | 'waiting_admit' | 'recording' | 'uploading' | 'done' | 'failed';
  reason: string | null;
}

const BOT_STATUS_LABEL: Record<BotSession['status'], string> = {
  queued: 'Bot queued…',
  joining: 'Bot opening the meeting…',
  waiting_admit: 'Waiting in the lobby — admit “Notetaker Bot” in Meet',
  recording: 'Recording the meeting',
  uploading: 'Meeting ended — uploading & transcribing…',
  done: 'Done! The recording is in your Notetaker list.',
  failed: 'Failed',
};

const BOT_ACTIVE = new Set<BotSession['status']>(['queued', 'joining', 'waiting_admit', 'recording', 'uploading']);

function RecordMeetingCard() {
  const [meetUrl, setMeetUrl] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [session, setSession] = useState<BotSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = session !== null && BOT_ACTIVE.has(session.status);

  useEffect(() => {
    if (!active || !session) return;
    const t = setInterval(() => {
      api<{ meeting: BotSession }>(`/api/notetaker/meetings/${session.id}`)
        .then((r) => setSession({ ...r.meeting, id: session.id }))
        .catch(() => { /* transient poll errors are fine — keep the last state */ });
    }, 3000);
    return () => clearInterval(t);
  }, [active, session?.id, session?.status]);

  async function sendBot() {
    if (!meetUrl.trim() || dispatching) return;
    setDispatching(true);
    setError(null);
    setSession(null);
    try {
      const r = await api<{ meeting: { sessionId: string; status: BotSession['status'] } }>(
        '/api/notetaker/meetings',
        { method: 'POST', body: JSON.stringify({ meetingUrl: meetUrl.trim() }) },
      );
      setSession({ id: r.meeting.sessionId, status: r.meeting.status, reason: null });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  return (
    <Card className="p-6 space-y-4 mt-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Video className="h-4 w-4 text-aurora-1" />
          <h2 className="font-display text-xl tracking-tight text-foreground/95">
            Record a live Google Meet
          </h2>
        </div>
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          Paste a Meet link and our bot joins, records, and drops the notes here when the
          meeting ends. Admit the bot when it knocks.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Input
          value={meetUrl}
          onChange={(e) => setMeetUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendBot(); }}
          placeholder="https://meet.google.com/xxx-xxxx-xxx"
          disabled={dispatching || active}
        />
        <Button onClick={sendBot} disabled={dispatching || active || !meetUrl.trim()}>
          {dispatching ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
          ) : (
            <><Video className="h-4 w-4" /> Send bot</>
          )}
        </Button>
      </div>

      {session && (
        <div
          className={cn(
            'rounded-xl border px-4 py-3 text-[13px] flex items-center gap-2.5',
            session.status === 'failed'
              ? 'border-red-500/20 bg-red-500/[0.06] text-red-400/90'
              : session.status === 'done'
                ? 'border-aurora-1/25 bg-aurora-1/[0.07] text-foreground/90'
                : 'border-white/[0.08] bg-white/[0.03] text-foreground/85',
          )}
        >
          {active && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-aurora-1" />}
          <span>
            {BOT_STATUS_LABEL[session.status]}
            {session.status === 'failed' && session.reason ? ` — ${session.reason}` : ''}
          </span>
          {session.status === 'done' && (
            <Link to="/notetaker" className="ml-auto underline underline-offset-2 shrink-0">
              Open Notetaker
            </Link>
          )}
        </div>
      )}

      {error && (
        <p className="text-[12px] text-red-400/90 bg-red-500/8 border border-red-500/15 rounded-md px-3 py-2">
          {error}
        </p>
      )}
    </Card>
  );
}

export function NotetakerNew() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickFile(f: File) {
    setError(null);
    if (f.size > MAX_BYTES) {
      setError(`File exceeds ${MAX_BYTES / 1024 / 1024} MB limit.`);
      return;
    }
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  }

  async function upload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setProgress(0);

    // Use XHR for upload progress events (fetch doesn't expose them yet).
    const form = new FormData();
    form.append('audio', file);
    form.append('title', title);

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/notetaker');
      const t = getToken();
      if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const j = JSON.parse(xhr.responseText) as { notetaker: { id: string } };
            navigate(`/notetaker/${j.notetaker.id}`);
            resolve();
          } catch {
            reject(new Error('invalid server response'));
          }
        } else if (xhr.status === 0) {
          // Connection cut mid-stream — usually proxy/browser HTTP timeout.
          reject(new Error('request timed out — for very large files, processing can take >60s; the job is still running, check /notetaker'));
        } else {
          let msg = `upload failed (${xhr.status})`;
          try {
            const j = JSON.parse(xhr.responseText) as { error?: string };
            if (j?.error) msg = j.error;
          } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(form);
    }).catch((e) => {
      setError((e as Error).message);
      setUploading(false);
    });
  }

  return (
    <div className="fade-up max-w-[760px]">
      <Link to="/notetaker" className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors mb-6">
        <ArrowLeft className="h-3.5 w-3.5" /> Notetaker
      </Link>

      <header className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">New recording</div>
        <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
          Drop the <span className="italic text-aurora">audio</span>.
        </h1>
      </header>

      <Card className="p-6 space-y-6">
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Acme intro call · 2026-06-05"
            className="mt-1.5"
            disabled={uploading}
          />
        </div>

        <div>
          <Label>Audio file</Label>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !uploading && fileRef.current?.click()}
            className={cn(
              'mt-1.5 rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors',
              dragging
                ? 'border-aurora-1/60 bg-aurora-1/[0.06]'
                : 'border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04]',
              uploading && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPTED}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
              }}
              disabled={uploading}
            />
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileAudio className="h-6 w-6 text-aurora-1" />
                <div className="text-left">
                  <div className="text-[13px] text-foreground/95 font-display tracking-tight">{file.name}</div>
                  <div className="text-[11px] text-muted-foreground/70">{fmtSize(file.size)} · {file.type || 'audio'}</div>
                </div>
                {!uploading && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFile(null); setProgress(0); }}
                    className="ml-2 h-7 w-7 rounded-full border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center"
                    aria-label="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <>
                <UploadCloud className="mx-auto h-8 w-8 text-aurora-2/80 mb-3" />
                <p className="font-display text-base text-foreground/90">Drop an audio file here</p>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                  mp3, m4a, wav, webm, ogg, flac — up to {MAX_BYTES / 1024 / 1024} MB
                </p>
              </>
            )}
          </div>
          {uploading && (
            <div className="mt-3">
              <div className="h-1 rounded-full bg-white/[0.05] overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-aurora-1 to-aurora-2 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/65 mt-1.5">
                Uploading · {progress}%
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="text-[12px] text-red-400/90 bg-red-500/8 border border-red-500/15 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.05]">
          <Button variant="ghost" asChild>
            <Link to="/notetaker">Cancel</Link>
          </Button>
          <Button onClick={upload} disabled={!file || uploading}>
            {uploading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</>
            ) : (
              <><Sparkles className="h-4 w-4" /> Upload & transcribe</>
            )}
          </Button>
        </div>
      </Card>

      <RecordMeetingCard />

      <p className="text-[11px] text-muted-foreground/60 italic mt-4 leading-relaxed">
        The upload includes transcription + notes — typically 30-60 seconds for a few-minute file,
        longer for large meetings. Leave this page open while it runs; we redirect you to the result
        as soon as it's ready.
      </p>
    </div>
  );
}
