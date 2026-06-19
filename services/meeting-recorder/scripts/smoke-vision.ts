// Manual smoke test for the vision liveness check against the REAL OpenAI API.
//
//   OPENAI_API_KEY="..." BOT_DISPLAY_NAME="dev gomagentic" \
//     npx tsx scripts/smoke-vision.ts [path-to-screenshot.png]
//
// Defaults to probe-failure.png (a real Meet frame: Harshit + the bot tile),
// where the expected answer is others=1.
import { readFileSync } from 'node:fs';
import { countOthersInScreenshot } from '../src/liveness-vision';

const png = readFileSync(process.argv[2] ?? 'probe-failure.png');
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY not set');

const others = await countOthersInScreenshot(new Uint8Array(png), {
  apiKey,
  model: process.env.VISION_MODEL ?? 'gpt-4o-mini',
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  botDisplayName: process.env.BOT_DISPLAY_NAME ?? 'Notetaker Bot',
});
console.log(`\nRESULT: others=${others}  (null=unknown; for probe-failure.png expect 1)`);
