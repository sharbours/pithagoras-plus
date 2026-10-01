// Characters listed in the avatar's picker. Served by the portal, so plain .vrm files work by URL.
// Put the .vrm files in ./characters/ (they are git-ignored; see README.md in this folder).
// Display name here; the model's own metadata (name/author/license) shows as the credit line when picked.
window.AVATAR_CHARACTERS = window.AVATAR_CHARACTERS || [];
window.AVATAR_CHARACTERS.push(
  { id: "seed-san", name: "Seed-san (simple)", url: "characters/seed-san.vrm",
    credit: "Seed-san by VirtualCast, Inc. Used under the VRM Public License 1.0 (vrm.dev/licenses/1.0)" },
  { id: "atomic-age-robot", name: "Atomic Age Robot", url: "characters/Atomic-Age-Robot.vrm",
    credit: "Atomic Age Robot — procedural VRM (Avatar Lab)" },
  { id: "cyber-elf", name: "Cyber-Elf", url: "characters/Cyber-Elf.vrm",
    credit: "SiliconForest.net 2026" },
  { id: "cyberjt", name: "Cyber J.T.", url: "characters/CyberJT.vrm" },
  { id: "deadpool", name: "Deadpool", url: "characters/Deadpool.vrm" },
  { id: "emerald", name: "Emerald", url: "characters/Emerald.vrm" },
  { id: "green-martian-warrior", name: "Green Martian Warrior", url: "characters/Green-Martian-Warrior.vrm",
    credit: "Green Martian Warrior — VRM 1.0 (Avatar Lab)" },
  { id: "grove-walker-tree", name: "Grove-Walker Tree", url: "characters/Grove-Walker-Tree.vrm",
    credit: "Grove-Walker Tree — procedural VRM (Avatar Lab)" },
  { id: "halcyon-android", name: "Halcyon Android", url: "characters/Halcyon-Android.vrm",
    credit: "Halcyon Android — procedural VRM (Avatar Lab)" },
  { id: "model20", name: "Model 20", url: "characters/Model20.vrm" },
  { id: "model21", name: "Model21", url: "characters/Model21.vrm" },
  { id: "scarab-hexapod", name: "Scarab Hexapod", url: "characters/Scarab-Hexapod.vrm",
    credit: "Scarab Hexapod — procedural VRM (Avatar Lab)" },
  { id: "steampunk-automaton", name: "Steampunk Automaton", url: "characters/Steampunk-Automaton.vrm",
    credit: "Steampunk Automaton — procedural VRM (Avatar Lab)" },
  { id: "techno-elf", name: "Techno-Elf", url: "characters/Techno-Elf.vrm",
    credit: "Techno-Elf by Sean Harbour, VRoid Studio 2.14" },
  { id: "violet", name: "Violet", url: "characters/Violet.vrm" },
);
