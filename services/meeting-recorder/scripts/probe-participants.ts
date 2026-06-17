// DIAGNOSTIC (temporary): join a real Meet with the bot's saved session and
// dump the actual participant-count DOM, so we can fix the brittle selector.
//
//   STORAGE_STATE_PATH=./secrets/storageState.json \
//     npx tsx scripts/probe-participants.ts "https://meet.google.com/xxx-yyyy-zzz"
//
// Join the meeting yourself first (from a DIFFERENT Google account) so there is
// another participant for the bot to count, then admit the bot.
import { chromium } from 'playwright';
import { MEET_SELECTORS } from '../src/meet-selectors';
import { joinMeeting, isInCall, dumpParticipantCandidates, readParticipantCount } from '../src/bot-driver';

const meetingUrl = process.argv[2];
if (!meetingUrl) {
  console.error('usage: tsx scripts/probe-participants.ts <meetingUrl>');
  process.exit(1);
}
const storageStatePath = process.env.STORAGE_STATE_PATH ?? './secrets/storageState.json';

const browser = await chromium.launch({
  headless: false,
  args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ storageState: storageStatePath });
const page = await context.newPage();
try {
  console.log('[probe] navigating to', meetingUrl);
  await page.goto(meetingUrl, { waitUntil: 'load' });
  await joinMeeting(page, MEET_SELECTORS, 'Probe Bot', 5 * 60_000);
  if (!(await isInCall(page, MEET_SELECTORS))) throw new Error('not_admitted');
  console.log('[probe] in call — dumping participant DOM candidates:\n');
  console.log(await dumpParticipantCandidates(page));

  // Richer probe: full toolbar, participant tiles, and the People button HTML.
  // NOTE: no named function/const declarations inside evaluate — tsx/esbuild
  // injects a `__name` helper that doesn't exist in the page context.
  const rich = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button[aria-label]'))
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter(Boolean);
    const dataParticipants = document.querySelectorAll('[data-participant-id]').length;
    const peopleTextEls = Array.from(document.querySelectorAll('*'))
      .filter((el) => /^People\s*\d+$/.test((el.textContent ?? '').trim()))
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').slice(0, 60),
        text: (el.textContent ?? '').trim(),
        closestButtonAria: el.closest('button')?.getAttribute('aria-label') ?? null,
      }));
    return { allButtonAriaLabels: buttons, dataParticipantTiles: dataParticipants, peopleTextEls };
  });
  console.log('\n[probe] RICH DUMP:\n' + JSON.stringify(rich, null, 2));

  // Open the People panel and dump the roster + speaking-indicator DOM so we
  // can confirm/correct peopleButton / participantRow / participantName /
  // speakingIndicator in meet-selectors.ts.
  console.log('\n[probe] opening People panel via', MEET_SELECTORS.peopleButton);
  const peopleBtn = page.locator(MEET_SELECTORS.peopleButton).first();
  if (await peopleBtn.count().catch(() => 0)) {
    await peopleBtn.click({ timeout: 5000 }).catch((e) => console.log('[probe] people click failed:', e.message));
    await page.waitForTimeout(1500);
  } else {
    console.log('[probe] peopleButton NOT FOUND — selector needs fixing');
  }
  const panel = await page.evaluate((sel) => {
    const rows = Array.from(document.querySelectorAll(sel.row));
    const nameMatches = Array.from(document.querySelectorAll(sel.name)).length;
    const speakingMatches = Array.from(document.querySelectorAll(sel.speak)).length;
    return {
      participantRowMatches: rows.length,
      participantRowSample: rows.slice(0, 4).map((r) => ({
        tag: r.tagName.toLowerCase(),
        ariaLabel: r.getAttribute('aria-label'),
        dataPid: r.getAttribute('data-participant-id'),
        text: (r.textContent ?? '').trim().slice(0, 60),
        class: (r.getAttribute('class') ?? '').slice(0, 80),
      })),
      participantNameMatches: nameMatches,
      speakingIndicatorMatches: speakingMatches,
    };
  }, { row: MEET_SELECTORS.participantRow, name: MEET_SELECTORS.participantName, speak: MEET_SELECTORS.speakingIndicator });
  console.log('\n[probe] PANEL DUMP (current guessed selectors):\n' + JSON.stringify(panel, null, 2));

  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    const count = await readParticipantCount(page, MEET_SELECTORS);
    console.log(`[probe] poll#${i} participantTiles=${count} others=${count - 1}`);
  }
  console.log('[probe] done — leaving the bot in the call; close this process to exit.');
} catch (e) {
  console.error('[probe] error:', (e as Error).message, '[page:', page.url(), ']');
  await page.screenshot({ path: './probe-failure.png' }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
