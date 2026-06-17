import type { Page } from 'playwright';
import type { Platform } from './platform';
import { PROBE_SOURCE, type ProbeSample } from './participant-probe';

export interface TimelineSample {
  // Milliseconds since the recording started (same origin as the audio, so it
  // lines up with the transcriber's word timestamps).
  tMs: number;
  speaking: string[];
}

export interface SpeakerSegment {
  startMs: number;
  endMs: number;
  name: string;
}

/**
 * Tracks the participants panel of a live meeting: who is in the room (the
 * roster, used both for liveness and for diarization names) and who is speaking
 * at each moment (the timeline that maps transcriber speaker indices to names).
 *
 * Platform-agnostic: all DOM specifics come from `platform.selectors`.
 */
export class ParticipantTracker {
  private roster = new Set<string>();
  private samples: TimelineSample[] = [];

  constructor(
    private readonly page: Page,
    private readonly platform: Platform,
    private readonly botDisplayName: string,
    private readonly startedAtMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Open the People panel so the roster + speaking indicators are in the DOM.
   * The bot auto-discovers the People button (no hand-confirmed selector) and
   * clicks it via Playwright so Meet sees a trusted event. Best-effort: if it
   * can't be found, polls just read an empty roster, which the fail-safe in the
   * runner treats as "unknown", never "alone".
   */
  async openPanel(): Promise<void> {
    await this.ensureInjected();
    const marked = await this.page
      .evaluate(() => (window as unknown as { __ntProbe: { markPeopleButton(): boolean } }).__ntProbe.markPeopleButton())
      .catch(() => false);
    if (marked) await this.page.locator('[data-nt-people="1"]').first().click({ timeout: 5000 }).catch(() => {});
    const d = await this.page
      .evaluate(() => (window as unknown as { __ntProbe: { discover(): { strategy: string; count: number } } }).__ntProbe.discover())
      .catch(() => null);
    if (d) console.log(`[tracker ${this.platform.id}] panel discovery: strategy=${d.strategy} rows=${d.count}`);
  }

  /**
   * One poll cycle: auto-discover the roster + active speakers via the in-page
   * probe and record a timeline sample. Returns the confident count of OTHER
   * participants, or `null` if the panel couldn't be read at all.
   *
   * A working read always sees at least the bot's own row, so `ok=false` /
   * zero participants means the probe found nothing (DOM drift / panel not
   * open) — the caller MUST treat null as "unknown" and never start the alone
   * countdown on it. This is the deliberate inverse of the old bug, where an
   * unread DOM read as "alone".
   */
  async poll(): Promise<number | null> {
    await this.ensureInjected();
    const s = await this.page
      .evaluate(() => (window as unknown as { __ntProbe: { sample(): ProbeSample } }).__ntProbe.sample())
      .catch(() => null) as ProbeSample | null;
    if (!s || !s.ok || s.participants.length === 0) {
      // DIAGNOSTIC: an unreadable panel reads as "unknown" (never "alone").
      console.log(`[tracker ${this.platform.id}] poll unreadable: ok=${s?.ok ?? 'null'} strategy=${s?.strategy ?? 'n/a'} participants=${s?.participants.length ?? 'n/a'} → others=null`);
      return null;
    }

    const others = s.participants.filter((n) => !this.isBot(n));
    for (const n of others) this.roster.add(n);
    const speaking = s.speaking.filter((n) => !this.isBot(n));
    this.samples.push({ tMs: Math.max(0, this.now() - this.startedAtMs), speaking });
    // DIAGNOSTIC: exactly what the probe saw, so an early "alone" leave is explainable.
    console.log(`[tracker ${this.platform.id}] poll strategy=${s.strategy} participants=${JSON.stringify(s.participants)} speaking=${JSON.stringify(speaking)} others=${others.length}`);
    return others.length;
  }

  // Inject the auto-discovery probe if it isn't present (re-injects after any
  // in-call SPA navigation that would have wiped window.__ntProbe).
  private async ensureInjected(): Promise<void> {
    const present = await this.page
      .evaluate(() => !!(window as unknown as { __ntProbe?: unknown }).__ntProbe)
      .catch(() => false);
    if (!present) await this.page.evaluate(PROBE_SOURCE).catch(() => {});
  }

  /** Distinct participant names seen across the session (bot excluded). */
  participants(): string[] {
    return [...this.roster];
  }

  /** Coalesced who-spoke-when segments for the whole session. */
  timeline(): SpeakerSegment[] {
    return coalesceTimeline(this.samples);
  }

  private isBot(name: string): boolean {
    const n = name.trim().toLowerCase();
    const bot = this.botDisplayName.trim().toLowerCase();
    return n === bot || n === `${bot} (you)` || n.endsWith('(you)');
  }
}

/**
 * Fold a stream of timeline samples into per-speaker segments. A speaker who
 * appears in consecutive samples gets one merged segment spanning them.
 * Overlapping segments across different names are fine — the notetaker's
 * alignment resolves each transcriber speaker index by maximal overlap.
 */
export function coalesceTimeline(samples: TimelineSample[]): SpeakerSegment[] {
  if (samples.length === 0) return [];
  const segments: SpeakerSegment[] = [];
  const open = new Map<string, number>(); // name -> startMs
  for (const sample of samples) {
    const t = sample.tMs;
    const speakingNow = new Set(sample.speaking);
    for (const [name, startMs] of [...open]) {
      if (!speakingNow.has(name)) {
        segments.push({ startMs, endMs: t, name });
        open.delete(name);
      }
    }
    for (const name of speakingNow) {
      if (!open.has(name)) open.set(name, t);
    }
  }
  const lastT = samples[samples.length - 1]!.tMs;
  for (const [name, startMs] of open) {
    segments.push({ startMs, endMs: Math.max(lastT, startMs), name });
  }
  return segments;
}
