// Run once, interactively, to capture the bot's Google session:
//   xvfb-run -a npx tsx scripts/bootstrap-login.ts   (on the VM, headed)
// Or locally with a visible browser. Sign in fully, solve any challenge, then
// press Enter in the terminal to save storageState.
import { chromium } from 'playwright';
import { createInterface } from 'node:readline/promises';

const OUT = process.env.STORAGE_STATE_PATH ?? './secrets/storageState.json';

const ctx = await chromium.launchPersistentContext('', { headless: false });
const page = await ctx.newPage();
await page.goto('https://accounts.google.com/');
console.log('Sign in to the bot Google account in the browser window.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter here once you are fully signed in... ');
await ctx.storageState({ path: OUT });
console.log(`Saved storage state to ${OUT}`);
await ctx.close();
process.exit(0);
