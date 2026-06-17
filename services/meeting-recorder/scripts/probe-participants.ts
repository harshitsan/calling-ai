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
import { joinMeeting, isInCall, dumpParticipantCandidates } from '../src/bot-driver';
import { PROBE_SOURCE } from '../src/participant-probe';

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

  // Inject the SAME auto-discovery probe the bot uses and verify what it finds
  // — this is no longer about hand-picking selectors, just confirming the
  // runtime discovery works against the live DOM.
  await page.evaluate(PROBE_SOURCE);
  const marked = await page.evaluate(() => (window as any).__ntProbe.markPeopleButton());
  console.log('\n[probe] auto-discovered People button:', marked);
  if (marked) await page.locator('[data-nt-people="1"]').first().click({ timeout: 5000 }).catch((e) => console.log('[probe] click failed:', e.message));
  await page.waitForTimeout(1500);
  console.log('[probe] discover():', JSON.stringify(await page.evaluate(() => (window as any).__ntProbe.discover())));

  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    const sample = await page.evaluate(() => (window as any).__ntProbe.sample());
    console.log(`[probe] poll#${i} sample=${JSON.stringify(sample)}`);
  }
  console.log('[probe] done — leaving the bot in the call; close this process to exit.');
} catch (e) {
  console.error('[probe] error:', (e as Error).message, '[page:', page.url(), ']');
  await page.screenshot({ path: './probe-failure.png' }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
}
