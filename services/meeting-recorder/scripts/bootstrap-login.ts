// Run once to capture the bot's Google session:
//   npx tsx scripts/bootstrap-login.ts            (local, visible browser)
//   xvfb-run -a npx tsx scripts/bootstrap-login.ts (on a headless VM)
// A browser window opens — sign in fully (solve any challenge). The script
// auto-detects sign-in (Google's durable session cookie) and saves storageState;
// no keypress needed, so it works when launched in the background too.
//
// Once the session is saved it is uploaded to R2 (key R2_KEY in bucket
// R2_BUCKET) so the Cloudflare Container can download it at boot — this is the
// same `wrangler r2 object put` you'd otherwise run by hand. Set SKIP_R2_UPLOAD=1
// for a local-docker-only setup that mounts the file instead.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const OUT = process.env.STORAGE_STATE_PATH ?? './secrets/storageState.json';
const R2_BUCKET = process.env.R2_BUCKET ?? 'calling-ai-recordings';
const R2_KEY = process.env.R2_KEY ?? 'internal/bot-storage-state.json';
const SIGNIN_TIMEOUT_MS = Number(process.env.SIGNIN_TIMEOUT_MS ?? 5 * 60_000);

const ctx = await chromium.launchPersistentContext('', { headless: false });
const page = await ctx.newPage();
await page.goto('https://accounts.google.com/');
console.log('Browser opened — sign in to the bot Google account fully.');
console.log('The session is captured automatically once you are signed in...');

// Google sets __Secure-1PSID (durable session cookie) only after full auth.
const deadline = Date.now() + SIGNIN_TIMEOUT_MS;
let signedIn = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies('https://accounts.google.com');
  if (cookies.some((c) => (c.name === '__Secure-1PSID' || c.name === 'SID') && c.value.length > 20)) {
    signedIn = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!signedIn) {
  console.error(`Timed out after ${Math.round(SIGNIN_TIMEOUT_MS / 1000)}s waiting for sign-in. Re-run when ready.`);
  await ctx.close();
  process.exit(1);
}
// Let any remaining auth cookies settle, then snapshot.
await new Promise((r) => setTimeout(r, 3000));
await ctx.storageState({ path: OUT });
console.log(`Signed in. Saved storage state to ${OUT}`);
await ctx.close();

if (process.env.SKIP_R2_UPLOAD) {
  console.log('SKIP_R2_UPLOAD set — leaving the session local only.');
  process.exit(0);
}

// Upload now that the session is set, so the container's boot-time download
// (STORAGE_STATE_URL → this object) succeeds. Needs `wrangler login` auth.
try {
  console.log(`Uploading session to R2: ${R2_BUCKET}/${R2_KEY}`);
  execFileSync(
    'npx',
    ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET}/${R2_KEY}`,
      '--file', OUT, '--content-type', 'application/json', '--remote'],
    { stdio: 'inherit' },
  );
  console.log('Upload complete — the recorder container will pick up this session on its next boot.');
} catch {
  console.error(
    `\nR2 upload failed. The session is still saved at ${OUT}; upload it by hand with:\n` +
    `  npx wrangler r2 object put ${R2_BUCKET}/${R2_KEY} --file ${OUT} --content-type application/json --remote`,
  );
  process.exit(1);
}
process.exit(0);
