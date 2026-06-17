import type { Page } from 'playwright';
import type { Selectors } from './meet-selectors';
import type { Platform } from './platform';

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
   * Best-effort: if the button is missing, polls just read an empty roster,
   * which the fail-safe in the runner treats as "unknown", never "alone".
   */
  async openPanel(): Promise<void> {
    const btn = this.page.locator(this.platform.selectors.peopleButton).first();
    if (await btn.count().catch(() => 0)) await btn.click({ timeout: 5000 }).catch(() => {});
  }

  /**
   * One poll cycle: read the roster + active speakers and record a timeline
   * sample. Returns the confident count of OTHER participants (excluding the
   * bot), or `null` if the panel couldn't be read at all.
   *
   * A working read always sees at least the bot's own row, so an empty result
   * means the selector didn't match (drift / panel not open) — the caller MUST
   * treat null as "unknown" and never start the alone countdown on it. This is
   * the deliberate inverse of the old bug, where an unread DOM read as "alone".
   */
  async poll(): Promise<number | null> {
    const sel = this.platform.selectors;
    const names = await this.readRoster(sel).catch(() => [] as string[]);
    if (names.length === 0) return null;
    for (const n of names) if (!this.isBot(n)) this.roster.add(n);

    const speaking = (await this.readActiveSpeakers(sel).catch(() => [] as string[]))
      .filter((n) => !this.isBot(n));
    this.samples.push({ tMs: Math.max(0, this.now() - this.startedAtMs), speaking });

    return names.length - 1; // minus the bot's own row
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

  private readRoster(sel: Selectors): Promise<string[]> {
    return this.page.evaluate(
      (s) => Array.from(document.querySelectorAll(s.row)).map((r) => {
        const el = s.name ? r.querySelector(s.name) : r;
        return (((el && el.textContent) || (r.textContent || '')) as string).trim();
      }).filter((t) => t.length > 0),
      { row: sel.participantRow, name: sel.participantName },
    );
  }

  private readActiveSpeakers(sel: Selectors): Promise<string[]> {
    return this.page.evaluate(
      (s) => Array.from(document.querySelectorAll(s.row)).filter((r) => !!r.querySelector(s.speak)).map((r) => {
        const el = s.name ? r.querySelector(s.name) : r;
        return (((el && el.textContent) || (r.textContent || '')) as string).trim();
      }).filter((t) => t.length > 0),
      { row: sel.participantRow, name: sel.participantName, speak: sel.speakingIndicator },
    );
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
