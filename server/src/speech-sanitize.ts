/**
 * TTS input sanitizer. Every voice path (live voice pipeline, SpeakReplies,
 * presets preview) funnels through the portal's /voice/speech endpoint, so this
 * is the single place where "never spoken" content is removed before any TTS
 * engine sees it:
 *
 *  - Emoji and decorative symbols. Kokoro/Breeze read them by their Unicode
 *    names — a bare 💥 is spoken as "collision symbol" (heard as "collision"),
 *    💃🕺 as "woman dancing, man dancing" (heard as "man woman") — so they must
 *    be dropped, never transliterated.
 *  - Zero-width and invisible characters (ZWJ, BOM, bidi marks, soft hyphen)
 *    that otherwise surface as artifacts in the audio.
 *  - Bracketed tag text: avatar stage directions such as [exercise:deep_squat]
 *    or [pose:horse] are stripped client-side for KNOWN names, but the model
 *    invents unknown ones ([kick:highkick], [block:block]) that then reach TTS
 *    and are read aloud as "kick, high kick" / "block, block". Any bracketed
 *    segment containing a colon — plus markdown links [text](url) — is dropped
 *    here, so unknown or future tags can never reach the speaker. Plain
 *    bracketed text without a colon ([sic], [1]) is preserved: it is prose.
 *
 * Punctuation, ordinary words, and markdown speech cues like (laugh) are left
 * intact; the browser already strips known avatar tags before calling here.
 */
const INVISIBLE = /[\u034F\u061C\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Every pictographic symbol the TTS would otherwise read by name: emoji, dingbats,
// arrows, geometric shapes, misc symbols. \p{Extended_Pictographic} covers the
// astral emoji; the BMP ranges catch the older dingbat/arrow/symbol sets.
const DECORATIVE = /[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\u{1F1E6}-\u{1F1FF}\p{Extended_Pictographic}]/gu;
// Balanced bracket segments that look like a tag: a colon inside the brackets,
// or a markdown link ([text](...)). The match ends at the matching "]" / ")",
// so adjacent prose is never consumed.
const TAG_BRACKETS = /\[[^\[\]\n]*:[^\[\]\n]*\](?:\((?:[^\(\)\n])*\))?|\[[^\[\]\n]*\]\((?:[^\(\)\n])*\)/g;
// Unclosed "[...:" at the very end (streaming edge) — nothing to speak of it.
const DROPPED_TAIL = /\[[^\[\]\n]*:[^\[\]\n]*$/;

/** Reduce text to what a TTS engine should actually say. "" means "nothing to speak". */
export function sanitizeSpeechText(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(DROPPED_TAIL, "");
  s = s.replace(INVISIBLE, "");
  s = s.replace(TAG_BRACKETS, " ");
  s = s.replace(DECORATIVE, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return /\p{L}/u.test(s) ? s : "";
}
