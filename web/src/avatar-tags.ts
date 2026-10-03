/**
 * Avatar tags: silent stage directions the model writes into spoken replies, e.g.
 * "[happy] Sure! [wave] See you." They are removed before text-to-speech and from the
 * voice transcript, and forwarded to the avatar when their sentence starts playing.
 *
 * Only known names are treated as tags, so ordinary bracketed text ("[1]", "[sic]")
 * is left alone. The speech cues (laugh), (sigh), ... are not touched here: they still go
 * to TTS, and the avatar reacts to them itself.
 *
 * Any [word:…] segment is treated as a tag and removed: besides the known
 * [pose:…] / [expr:…] / [exercise:…] prefixes, the model invents [kick:…],
 * [block:…] and the like — those must never reach TTS (they would be read aloud
 * as "kick, high kick"). Invented names are simply ignored by the avatar, and
 * the portal's /voice/speech endpoint re-strips anything that slips through,
 * so this is belt-and-braces, not the only line of defence.
 */
const EMOTIONS = "neutral happy sad angry surprised relaxed thinking sleepy shy smirk pout squint shocked";
const GESTURES = "nod shake tilt bounce wave bow shrug clap point think scratch cheer dance jump facepalm crossarms hips giggle stretch lookaround sigh wink lookup lookdown lookleft lookright backflip spin thumbsup peace ok fist openpalm fingerguns horns hearthands pirouette armwave disco raisetheroof groove phone";
const KNOWN = new Set(`${EMOTIONS} ${GESTURES}`.split(" "));
const PREFIXED = new Set(["pose", "expr", "exercise"]);   // [pose:horse], [expr:HeartEyes:0.6], [exercise:deep_squat:3]
const TAG = /\[([a-z]+)(?::([^\]\s:]{1,40}))?(?::([0-9.]+))?\]/gi;

const isTag = (name: string, value?: string) => PREFIXED.has(name.toLowerCase())
  ? !!value
  : value !== undefined || KNOWN.has(name.toLowerCase());

/** Remove avatar tags and emoji (TTS would read them by name: 💥 → "collision"); tidy the spacing they leave behind. */
export function stripAvatarTags(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F\u00AD\u034F\u061C\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "") // invisible / control chars
    .replace(/\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]*/gu, " ") // emoji, incl. modifier + ZWJ sequences
    .replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF\u{1F1E6}-\u{1F1FF}]/gu, " ") // arrows, dingbats, geometric, misc symbols, flag (regional-indicator) pairs
    .replace(TAG, (all, name, value) => (isTag(name, value) ? " " : all))
    .replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.!?])/g, "$1").trim();
}

/** A trailing, still-streaming "[hap" that could become a tag is hidden until it resolves. */
export function hidePartialAvatarTag(text: string): string {
  const m = /\[([a-z]*)(?::[^\]\s]{0,40})?$/i.exec(text);
  if (!m) return text;
  const name = m[1].toLowerCase();
  const could = !name || [...KNOWN, ...PREFIXED].some(k => k.startsWith(name));
  return could ? text.slice(0, m.index) : text;
}

/**
 * Swap every known avatar tag for a single Private-Use-Area code point, so a
 * downstream text-cleanup pass (speechChunks strips markdown `*_`… chars) can
 * not mangle the tag's name — `deep_squat` must survive as `deep_squat`, not
 * `deepsquat`. A BMP PUA char is a single UTF-16 code unit (never split by the
 * chunker's 600-char boundary) and is not a letter, digit, punctuation or
 * whitespace, so no cleanup / word-count / link pass can touch or consume it.
 * Pair with the returned `restore`.
 */
export function protectAvatarTags(text: string): { guarded: string; restore: (s: string) => string } {
  const tagToToken = new Map<string, string>();
  const tokenToTag = new Map<string, string>();
  let next = 0xe000;
  const guarded = text.replace(TAG, (all, name, value) => {
    if (!isTag(name, value)) return all;
    let token = tagToToken.get(all);
    if (!token) {
      token = String.fromCodePoint(next++);
      tagToToken.set(all, token);
      tokenToTag.set(token, all);
    }
    return token;
  });
  return { guarded, restore: s => s.replace(/[\uE000-\uF8FF]/g, t => tokenToTag.get(t) ?? t) };
}

/** Split one speech chunk into what TTS should say and the cues for the avatar. */
export function splitAvatarTags(text: string): { spoken: string; cues: string } {
  return { spoken: stripAvatarTags(text), cues: text };
}

/** Hand a sentence's cues to the avatar at the moment its audio starts playing. */
export function avatarCue(cues: string, durationMs = 0) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pith-avatar", { detail: { cues, durationMs } }));
}
