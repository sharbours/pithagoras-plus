/**
 * Persona (Personality) store — the shared contract between the avatar options
 * panel and the web app.
 *
 * The avatar page and this app are same-origin on the portal, so they share
 * one localStorage. The avatar's gear picker is the ONLY editor: it writes a
 * per-character assignment and a set of shared, user-editable definitions.
 * This module just reads that store so the web app can resolve the active
 * avatar's personality text and ship it with every prompt it sends (text and
 * voice both flow through api.prompt).
 *
 * Keys (namespaced under avatarLab.*, exactly as the avatar page writes them):
 *   avatarLab.personality.<charId>  -> the personality key that character uses
 *   avatarLab.personalityDefs       -> JSON { [key]: { label, text } }
 *   avatarLab.character             -> the restored (last-picked) character id
 *
 * There is deliberately NO global "current personality" key: the per-character
 * assignment IS the source of truth. A global mirror would go stale the moment
 * the user switched to a character with no assignment of its own (it would keep
 * pointing at the previous character's choice).
 */

/** The four personalities the avatar panel ships with (seed only). */
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

function get(key: string): string | null {
  try {
    return localStorage.getItem("avatarLab." + key);
  } catch {
    return null;
  }
}

function defs(): Record<string, { label: string; text: string }> {
  const raw = get("personalityDefs");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through to seeds */
    }
  }
  return DEFAULT_PERSONAS;
}

/**
 * Resolve the personality text for the avatar the user is currently using.
 * Reads the restored character's per-character assignment and resolves it
 * against the shared definitions; returns "" for "default" / no assignment /
 * unknown key (meaning: no persona, byte-identical to pre-feature). The
 * per-character key is the sole source of truth — there is no global mirror to
 * fall back to, so switching to a character with no assignment yields no persona.
 */
export function personaText(): string {
  const charId = get("character");
  if (!charId) return "";
  const key = get(`personality.${charId}`);
  if (!key || key === "default") return "";
  const def = defs()[key];
  const text = def?.text;
  return typeof text === "string" ? text.trim() : "";
}
