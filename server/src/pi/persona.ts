/**
 * Conversation "persona" (a.k.a. Personality) — the way the agent talks.
 *
 * A persona is not a model: it does not route anywhere, it only changes the
 * agent's tone/voice. It is folded into the message the user sends, the same
 * way the voice turn's [Audio mode] wrapper is — a small block the model reads
 * before the user's words. Riding on the message (not the system prompt) means
 * a change takes effect on the very next turn without restarting pi.
 *
 * Unlike the old per-session "mood", a persona is defined and stored by the
 * CLIENT, on a per-avatar basis: the avatar options panel lets each character
 * pick a personality, the personality's text is user-editable, and the same
 * personality (the same key) can be shared by several avatars. The client is
 * the source of truth and ships the resolved text with every prompt, so the
 * server only has to inject it — it no longer owns a fixed mood catalogue.
 */

/**
 * Hard cap on how much persona text is folded into a message. The text is
 * user-authored (their own portal, so it is trusted), but a runaway value must
 * not eat the model's context window; anything over the cap is truncated.
 */
export const PERSONA_MAX_CHARS = 2000;

/**
 * The four personalities the avatar panel ships with, as the default seed for
 * the client's shared personality definitions. Keys match the old mood keys so
 * existing assignments keep their meaning. (The client owns the editable copy;
 * these are only the starting values.)
 */
export const DEFAULT_PERSONAS: Record<string, { label: string; text: string }> = {
  default: { label: "Default", text: "" },
  helpful: {
    label: "Helpful",
    text:
      "You are in a Helpful mood. Be warm, patient, and practical: give a clear, direct answer first, then offer one useful next step. Skip small talk and hedging; just be genuinely useful.",
  },
  playful: {
    label: "Playful insults",
    text:
      "You are in a Playful insults mood. Tease the user lightly and good-naturedly with a witty, good-humored dig or joke, but ALWAYS still answer the question correctly and helpfully — the teasing is the seasoning, the answer is the meal. Never be mean, cruel, or insulting in a way that isn't playful.",
  },
  teacher: {
    label: "Teacher",
    text:
      "You are in a Teacher mood. Explain things clearly and step by step, the way a patient teacher would: define terms, show the reasoning, check understanding, and encourage. Keep it conversational rather than lecturing.",
  },
};

/**
 * Normalize a raw persona value coming in from the client. Accepts a string,
 * trims it, drops it if it is empty/"default" (the no-persona state), and caps
 * it at PERSONA_MAX_CHARS so a huge block can never flood the context. Returns
 * "" when there is no persona to apply.
 */
export function normalizePersona(value: unknown): string {
  if (typeof value !== "string") return "";
  let t = value.trim();
  if (!t || t.toLowerCase() === "default") return "";
  if (t.length > PERSONA_MAX_CHARS) t = t.slice(0, PERSONA_MAX_CHARS);
  return t;
}

/**
 * Wrap a message with the persona text. An empty persona is a no-op — the text
 * is returned exactly as given (byte-identical to a run with no persona). The
 * block is placed BEFORE the user's words so the model reads the persona first,
 * then the message; it stacks under the voice [Audio mode] marker added
 * downstream (persona first, then the mode marker, then the words).
 */
export function applyPersona(message: string, persona?: string | null): string {
  const text = normalizePersona(persona);
  if (!text) return message;
  return `<persona>\n${text}\n</persona>\n\n${message}`;
}
