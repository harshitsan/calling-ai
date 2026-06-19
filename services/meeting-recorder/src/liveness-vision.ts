// Vision-based liveness check.
//
// The DOM roster can't reliably tell the bot apart from the humans: when signed
// in, the bot's Meet name is its Google account name (not BOT_DISPLAY_NAME), so
// name-based self-exclusion fails and the bot counts itself as a participant —
// which is why it used to never leave an empty meeting. Rather than chase
// Meet's obfuscated DOM, we screenshot the page and ask a vision model the only
// question that matters for leaving: "ignoring the bot's own self-view tile, how
// many other people are here?"
//
// Uses OpenAI chat-completions vision (raw fetch, matching the project's
// existing OpenAI client) with a strict JSON schema so the answer is a clean
// integer. `detail: 'low'` keeps it fast and cheap — counting tiles needs no
// fine detail.

export interface VisionConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  // The bot's Meet display name (its Google account name), so the model knows
  // which tile to exclude.
  botDisplayName: string;
}

const SYSTEM_PROMPT =
  'You are a vision classifier for a meeting-recording bot. You are shown a ' +
  "screenshot of the bot's own Google Meet browser window. The bot attends as " +
  'a muted, camera-off participant; its own self-view appears as one tile ' +
  '(often a small picture-in-picture tile in a corner) labelled with the bot ' +
  "account name. Count how many OTHER human participants are visible, NOT " +
  "counting the bot's own tile. If the room is empty except for the bot, " +
  'others is 0. Set botVisible true only if you can see the bot\'s own tile.';

interface VisionAnswer {
  others: number;
  botVisible: boolean;
  note: string;
}

/**
 * Ask the vision model how many participants other than the bot are visible.
 *
 * Returns the count of OTHER participants, or `null` if the check could not be
 * completed confidently (network/API error, unparseable answer, or a "0 others
 * but bot not visible" reading that likely isn't even the meeting view).
 * Callers MUST treat `null` as "unknown", never "alone" — the same fail-safe the
 * DOM path uses, so a flaky vision call can never trigger a premature leave.
 */
export async function countOthersInScreenshot(
  png: Uint8Array,
  cfg: VisionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const body = {
    model: cfg.model,
    max_tokens: 120,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `The bot account name is "${cfg.botDisplayName}". Its own tile is labelled with this name — exclude it from the count.`,
          },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'participant_count',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            others: { type: 'integer' },
            botVisible: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['others', 'botVisible', 'note'],
        },
      },
    },
  };

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`[vision] request threw: ${(e as Error).message} → others=null`);
    return null;
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.log(`[vision] status ${res.status} ${errBody.slice(0, 200)} → others=null`);
    return null;
  }

  let answer: VisionAnswer | null = null;
  try {
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; refusal?: string | null } }[];
    };
    const msg = json.choices?.[0]?.message;
    if (!msg || msg.refusal || typeof msg.content !== 'string') {
      console.log(`[vision] no content (refusal=${msg?.refusal ?? 'n/a'}) → others=null`);
      return null;
    }
    answer = JSON.parse(msg.content) as VisionAnswer;
  } catch (e) {
    console.log(`[vision] unparseable answer: ${(e as Error).message} → others=null`);
    return null;
  }

  if (typeof answer.others !== 'number' || !Number.isFinite(answer.others)) return null;
  // "0 others AND can't even see the bot" probably isn't the meeting view
  // (loading/transition screen) — treat as unknown rather than risk a false leave.
  if (answer.others <= 0 && !answer.botVisible) {
    console.log('[vision] others=0 but botVisible=false → others=null (uncertain view)');
    return null;
  }
  const others = Math.max(0, Math.trunc(answer.others));
  console.log(`[vision] others=${others} botVisible=${answer.botVisible} note=${JSON.stringify(answer.note)}`);
  return others;
}
