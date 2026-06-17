import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Config } from './config';
import type { Runner } from './session-manager';
import { detectPlatform } from './platform';
import { joinMeeting, isInCall, isRemoved, leaveMeeting } from './bot-driver';
import { ParticipantTracker } from './participant-tracker';
import { Recorder } from './recorder';
import { createSessionSink, removeSessionSink, type ExecFn } from './audio-sink';
import { decideEnd } from './end-detector';
import { uploadRecording } from './uploader';

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args);
  return { stdout };
};

export function makeRunner(
  config: Config,
  now: () => number = () => Date.now(),
  exec: ExecFn = defaultExec,
): Runner {
  return async (session, ctx) => {
    mkdirSync(config.recordingsDir, { recursive: true });
    const outputPath = join(config.recordingsDir, `${session.id}.mp3`);
    // Per-session sink: this session's Chromium plays only into it and this
    // session's ffmpeg records only its monitor — parallel sessions stay
    // acoustically isolated.
    const { sinkName, moduleId } = await createSessionSink(exec, session.id);
    // headed under Xvfb so meeting audio actually plays into the sink.
    const browser = await chromium.launch({
      headless: false,
      env: { ...(process.env as Record<string, string>), PULSE_SINK: sinkName },
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    // Restore the bot's pre-authenticated Google session captured by bootstrap-login.
    const context = await browser.newContext({ storageState: config.storageStatePath });
    const recorder = new Recorder({ outputPath, inputArgs: ['-f', 'pulse', '-i', `${sinkName}.monitor`] });
    const platform = detectPlatform(session.meetingUrl);
    const sel = platform.selectors;
    const page = await context.newPage();
    try {
      ctx.setStatus('joining');
      await page.goto(session.meetingUrl, { waitUntil: 'load' });
      ctx.setStatus('waiting_admit');
      await joinMeeting(page, sel, config.botDisplayName, config.lobbyTimeoutMs);
      if (!(await isInCall(page, sel))) throw new Error('not_admitted');

      ctx.setStatus('recording');
      recorder.start();
      const startedAtMs = now();
      // Tracker time origin == recorder start, so the speaker timeline lines up
      // with the transcriber's audio timestamps for diarization-by-name.
      const tracker = new ParticipantTracker(page, platform, config.botDisplayName, startedAtMs, now);
      await tracker.openPanel();
      let aloneSinceMs: number | null = null;

      for (;;) {
        await page.waitForTimeout(5000);
        const others = await tracker.poll();
        // Fail-safe: only run the alone timer on a CONFIDENT empty-room reading.
        // others===null means the roster couldn't be read (selector drift) — we
        // leave aloneSinceMs untouched and never start the countdown, so a
        // broken selector can no longer cause a silent early leave.
        if (others !== null) {
          if (others <= 0) aloneSinceMs ??= now();
          else aloneSinceMs = null;
        }
        const decision = decideEnd({
          removed: await isRemoved(page, sel),
          stopRequested: ctx.isStopRequested(),
          otherParticipants: others ?? 1, // unknown reads as "not alone"
          aloneSinceMs, startedAtMs, nowMs: now(),
          aloneGraceMs: config.aloneGraceMs, maxDurationMs: config.maxDurationMs,
        });
        if (decision.end) {
          session.reason = decision.reason;
          console.log(`[recorder ${session.id}] leaving: reason=${decision.reason} others=${others}`);
          break;
        }
      }

      await recorder.stop();
      await leaveMeeting(page, sel).catch(() => {});

      ctx.setStatus('uploading');
      const bytes = readFileSync(outputPath);
      await uploadRecording({
        // Per-session tenant key (multi-tenant) with the global key as fallback.
        notetakerUrl: config.notetakerUrl, apiKey: session.apiKey ?? config.notetakerApiKey,
        title: session.title, fileName: `${session.id}.mp3`, bytes: new Uint8Array(bytes),
        participants: tracker.participants(),
        speakerTimeline: tracker.timeline(),
      });
      ctx.setStatus('done', session.reason);
      rmSync(outputPath, { force: true });
    } catch (e) {
      // Meet's DOM varies between loads — keep evidence of what the bot saw.
      await page
        .screenshot({ path: join(config.recordingsDir, `${session.id}-failure.png`) })
        .catch(() => {});
      (e as Error).message += ` [page: ${page.url()}]`;
      throw e;
    } finally {
      await recorder.stop().catch(() => {});
      await browser.close().catch(() => {});
      await removeSessionSink(exec, moduleId).catch(() => {});
    }
  };
}
