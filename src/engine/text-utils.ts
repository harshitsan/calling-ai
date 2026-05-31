/**
 * Strip markdown syntax that would otherwise be voiced literally by a TTS
 * provider (e.g. Deepgram Aura reading "**" as "star star"). This is a
 * pure utility intended to run on each chunk between the chunker and the
 * TTS adapter.
 *
 * Goals:
 *  - Remove **bold** / __bold__ and *italic* / _italic_ wrappers (keep inner text).
 *  - Remove `code` backticks and ```fenced``` code fences (keep inner text).
 *  - Strip leading bullets ("- ", "* ", "+ ") and numbered lists ("1. ", "2) ").
 *  - Strip leading "#" heading markers.
 *  - Drop link syntax `[text](url)` -> `text`.
 *
 * Preserve:
 *  - Apostrophes ("don't", "it's").
 *  - Decimals ("1.5", "$1.99") — must not be mistaken for a numbered list.
 *  - Em-dashes / hyphens inside words ("state-of-the-art").
 *  - Bare arithmetic like "3 * 4" (not bounded by word boundaries on both sides).
 */
export function stripMarkdownForTts(s: string): string {
  return s
    // fenced code blocks: ```lang\n...``` -> inner text
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    // inline code: `x` -> x
    .replace(/`([^`]+)`/g, '$1')
    // bold: **x** or __x__
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // italic: *x* — only when bounded by non-word chars so "3*4" survives
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    // italic: _x_ — same guard, leaves file_name intact
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    // leading bullets "- ", "* ", "+ " at start of a line
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // leading numbered list "1. " / "2) " — requires trailing whitespace,
    // so decimals like "1.5" and "$1.99" are NOT matched
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
    // leading headings "# ".."###### "
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    // link syntax [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
