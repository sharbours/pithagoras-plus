/**
 * Conversation "mood" — a per-session persona the agent adopts.
 *
 * A mood is not a model: it does not route anywhere, it changes how the agent
 * talks. That makes it the wrong shape for the config's provider/model path
 * (which rebuilds the runtime). Instead it is folded into every message the
 * same way the voice turn's [Audio mode] wrapper is — a small block the model
 * reads before the user's words. Because it rides on the message rather than
 * the system prompt, changing the mood takes effect on the very next turn
 * without restarting pi, and it stays consistent turn to turn (a block in the
 * current message beats any mood block in older history).
 *
 * "default" means no mood — the block is not added at all, so a session that
 * never touches the control is byte-identical to before this feature existed.
 */
export const MOODS = {
  default: { label: "Default", block: null },
  helpful: {
    label: "Helpful",
    block:
      "You are in a Helpful mood. Be warm, patient, and practical: give a clear, direct answer first, then offer one useful next step. Skip small talk and hedging; just be genuinely useful.",
  },
  playful: {
    label: "Playful insults",
    block:
      "You are in a Playful insults mood. Tease the user lightly and good-naturedly with a witty, good-humored dig or joke, but ALWAYS still answer the question correctly and helpfully — the teasing is the seasoning, the answer is the meal. Never be mean, cruel, or insulting in a way that isn't playful.",
  },
  teacher: {
    label: "Teacher",
    block:
      "You are in a Teacher mood. Explain things clearly and step by step, the way a patient teacher would: define terms, show the reasoning, check understanding, and encourage. Keep it conversational rather than lecturing.",
  },
} as const;

export type MoodKey = keyof typeof MOODS;
export const MOOD_KEYS = Object.keys(MOODS) as MoodKey[];

export function isMoodKey(v: unknown): v is MoodKey {
  return typeof v === "string" && (MOOD_KEYS as string[]).includes(v);
}

/** The persona block for a mood, or "" for none. */
export function moodBlock(key: string | null | undefined): string {
  if (!key) return "";
  const mood = (MOODS as Record<string, { block: string | null }>)[key];
  return mood?.block ?? "";
}

/**
 * Wrap a message in the mood the session is currently in. "default"/"" means
 * no mood, so the text is returned exactly as given. The block is placed
 * BEFORE any other prefix (voice [Audio mode] is added downstream of this) so
 * the model reads the persona first, then the mode marker, then the words.
 */
export function applyMood(message: string, key: string | null | undefined): string {
  const block = moodBlock(key);
  if (!block) return message;
  return `<mood>\n${block}\n</mood>\n\n${message}`;
}
