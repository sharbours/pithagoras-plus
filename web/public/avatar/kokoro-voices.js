// TTS engine voices available on the local TTS backend.
// The portal's TTS adapter currently runs the Qwen3-TTS 12Hz 1.7B-CustomVoice
// engine (pithagoras-tts-adapter :7864 -> :7866), whose 9 preset speakers are
// listed here. Static, generated from the engine's /v1/voices on 2026-10-05 —
// the avatar page is self-contained (no fetch, no auth), so the list ships
// with the page. "g" groups the picker's optgroups; "id" is what the TTS
// adapter accepts (a Qwen3 speaker like vivian, or a legacy Kokoro id, which
// the adapter still maps for backwards compatibility).
// vivian is the portal's default and the per-character default if unset.
window.KOKORO_DEFAULT_VOICE = "vivian";
window.KOKORO_VOICES = [
  { id: "vivian",   g: "F", t: "Vivian · young female · bright, slightly edgy (default)" },
  { id: "serena",   g: "F", t: "Serena · young female · warm, gentle" },
  { id: "ono_anna", g: "F", t: "Ono Anna · Japanese female · playful, light, nimble" },
  { id: "sohee",    g: "F", t: "Sohee · Korean female · warm, rich emotion" },
  { id: "ryan",     g: "M", t: "Ryan · male · dynamic, strong rhythmic drive" },
  { id: "aiden",    g: "M", t: "Aiden · American male · sunny, clear midrange" },
  { id: "dylan",    g: "M", t: "Dylan · Beijing male · clear, natural" },
  { id: "eric",     g: "M", t: "Eric · Chengdu male · lively, slightly husky" },
  { id: "uncle_fu", g: "M", t: "Uncle Fu · seasoned male · low, mellow timbre" },
];
window.KOKORO_LABELS = Object.fromEntries(window.KOKORO_VOICES.map(v => [v.id, v.t]));
