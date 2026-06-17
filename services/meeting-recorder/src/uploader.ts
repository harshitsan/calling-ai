import type { SpeakerSegment } from './participant-tracker';

export interface UploadOptions {
  notetakerUrl: string;
  apiKey: string;
  title: string | null;
  fileName: string;
  bytes: Uint8Array;
  // Roster of participant names + who-spoke-when timeline, for speaker
  // diarization by real name on the notetaker side. Omitted when unavailable.
  participants?: string[];
  speakerTimeline?: SpeakerSegment[];
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  jobId: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function uploadRecording(opts: UploadOptions): Promise<UploadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${opts.notetakerUrl.replace(/\/$/, '')}/api/notetaker`;

  let lastErr = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const form = new FormData();
    // Uint8Array is a valid BlobPart at runtime; the assertion sidesteps a
    // strict lib mismatch (Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer>).
    form.append('audio', new File([opts.bytes as unknown as BlobPart], opts.fileName, { type: 'audio/mpeg' }));
    if (opts.title) form.append('title', opts.title);
    if (opts.participants && opts.participants.length > 0) {
      form.append('participants', JSON.stringify(opts.participants));
    }
    if (opts.speakerTimeline && opts.speakerTimeline.length > 0) {
      form.append('speakerTimeline', JSON.stringify(opts.speakerTimeline));
    }

    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'x-api-key': opts.apiKey }, body: form });
    } catch (e) {
      lastErr = `fetch threw: ${(e as Error).message}`;
      if (attempt < maxRetries) await sleep(attempt * 1000);
      continue;
    }
    if (res.ok) {
      const json = (await res.json()) as { notetaker?: { id?: string } };
      const jobId = json.notetaker?.id;
      if (!jobId) throw new Error('upload failed: response missing job id');
      return { jobId };
    }
    lastErr = `status ${res.status}`;
    // Only retry server-side failures; 4xx is a permanent client error.
    if (res.status < 500 || attempt >= maxRetries) break;
    await sleep(attempt * 1000);
  }
  throw new Error(`upload failed: ${lastErr}`);
}
