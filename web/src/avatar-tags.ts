/**
 * Avatar tags: silent stage directions the model writes into spoken replies, e.g.
 * "[happy] Sure! [wave] See you." They are removed before text-to-speech and from the
 * voice transcript, and forwarded to the avatar when their sentence starts playing.
 *
 * Only known names are treated as tags, so ordinary bracketed text ("[1]", "[sic]")
 * is left alone. The speech cues (laugh), (sigh), ... are not touched here: they still go
 * to TTS, and the avatar reacts to them itself.
 */
const EMOTIONS = "neutral happy sad angry surprised relaxed thinking sleepy shy smirk pout squint shocked";
const GESTURES = "nod shake tilt bounce wave bow shrug clap point think scratch cheer dance jump facepalm crossarms hips giggle stretch lookaround sigh wink lookup lookdown lookleft lookright backflip spin thumbsup peace ok fist openpalm fingerguns horns hearthands pirouette armwave disco raisetheroof groove";
const KNOWN = new Set(`${EMOTIONS} ${GESTURES}`.split(" "));
const PREFIXED = new Set(["pose", "expr"]);          // [pose:horse], [expr:HeartEyes:0.6]
const TAG = /\[([a-z]+)(?::([^\]\s:]{1,40}))?(?::([0-9.]+))?\]/gi;

const isTag = (name: string, value?: string) => PREFIXED.has(name.toLowerCase()) ? !!value : KNOWN.has(name.toLowerCase());

/** Remove avatar tags; tidy the spacing they leave behind. */
export function stripAvatarTags(text: string): string {
  return text.replace(TAG, (all, name, value) => (isTag(name, value) ? " " : all))
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

/** Split one speech chunk into what TTS should say and the cues for the avatar. */
export function splitAvatarTags(text: string): { spoken: string; cues: string } {
  return { spoken: stripAvatarTags(text), cues: text };
}

/** Hand a sentence's cues to the avatar at the moment its audio starts playing. */
export function avatarCue(cues: string, durationMs = 0) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("pith-avatar", { detail: { cues, durationMs } }));
}
