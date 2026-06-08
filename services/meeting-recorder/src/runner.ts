import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Config } from './config';
import type { Runner } from './session-manager';
import { MEET_SELECTORS } from './meet-selectors';
import { joinMeeting, isInCall, readParticipantCount, isRemoved, leaveMeeting } from './bot-driver';
import { Recorder } from './recorder';
import { decideEnd } from './end-detector';
import { uploadRecording } from './uploader';

export function makeRunner(config: Config, now: () => number = () => Date.now()): Runner {
  return async (session, ctx) => {
    mkdirSync(config.recordingsDir, { recursive: true });
    const outputPath = join(config.recordingsDir, `${session.id}.mp3`);
    // headed under Xvfb so meeting audio actually plays into the sink.
    const browser = await chromium.launch({
      headless: false,
      args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    // Restore the bot's pre-authenticated Google session captured by bootstrap-login.
    const context = await browser.newContext({ storageState: config.storageStatePath });
    const recorder = new Recorder({ outputPath, inputArgs: ['-f', 'pulse', '-i', `${config.audioSink}.monitor`] });
    const page = await context.newPage();
    try {
      ctx.setStatus('joining');
      await page.goto(session.meetingUrl, { waitUntil: 'load' });
      ctx.setStatus('waiting_admit');
      await joinMeeting(page, MEET_SELECTORS, config.botDisplayName, config.lobbyTimeoutMs);
      if (!(await isInCall(page, MEET_SELECTORS))) throw new Error('not_admitted');

      ctx.setStatus('recording');
      recorder.start();
      const startedAtMs = now();
      let aloneSinceMs: number | null = null;

      for (;;) {
        await page.waitForTimeout(5000);
        const others = (await readParticipantCount(page, MEET_SELECTORS)) - 1; // minus the bot
        if (others <= 0) aloneSinceMs ??= now();
        else aloneSinceMs = null;
        const decision = decideEnd({
          removed: await isRemoved(page, MEET_SELECTORS),
          stopRequested: ctx.isStopRequested(),
          otherParticipants: others,
          aloneSinceMs, startedAtMs, nowMs: now(),
          aloneGraceMs: config.aloneGraceMs, maxDurationMs: config.maxDurationMs,
        });
        if (decision.end) { session.reason = decision.reason; break; }
      }

      await recorder.stop();
      await leaveMeeting(page, MEET_SELECTORS).catch(() => {});

      ctx.setStatus('uploading');
      const bytes = readFileSync(outputPath);
      await uploadRecording({
        notetakerUrl: config.notetakerUrl, apiKey: config.notetakerApiKey,
        title: session.title, fileName: `${session.id}.mp3`, bytes: new Uint8Array(bytes),
      });
      ctx.setStatus('done', session.reason);
      rmSync(outputPath, { force: true });
    } finally {
      await recorder.stop().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
}
