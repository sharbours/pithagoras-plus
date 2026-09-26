// Characters listed in the avatar's picker. Served by the portal, so plain .vrm files work by URL.
// Put the .vrm files in ./characters/ (they are git-ignored; see README.md in this folder).
// Display name here; the model's own metadata (name/author/license) shows as the credit line when picked.
window.AVATAR_CHARACTERS = window.AVATAR_CHARACTERS || [];
window.AVATAR_CHARACTERS.push(
  { id: "seed-san", name: "Seed-san (simple)", url: "characters/seed-san.vrm",
    credit: "Seed-san by VirtualCast, Inc. Used under the VRM Public License 1.0 (vrm.dev/licenses/1.0)" },
  { id: "avatar-sample-b", name: "AvatarSample_B (complex)", url: "characters/avatar-sample-b.vrm",
    credit: "AvatarSample_B by pixiv Inc. (VRoid Project), VRM Public License 1.0" },
  { id: "batman", name: "Batman", url: "characters/Batman.vrm" },
  { id: "cyberjt", name: "Cyber J.T.", url: "characters/CyberJT.vrm" },
  { id: "deadpool", name: "Deadpool", url: "characters/Deadpool.vrm" },
  { id: "demongirl", name: "Demon Girl", url: "characters/DemonGirl.vrm" },
  { id: "emerald", name: "Emerald", url: "characters/Emerald.vrm" },
  { id: "ganondorf", name: "Ganondorf", url: "characters/Ganondorf.vrm" },
  { id: "hermione", name: "Hermione", url: "characters/Hermione.vrm" },
  { id: "ironman", name: "Iron Man", url: "characters/Ironman.vrm" },
  { id: "model10", name: "Model 10", url: "characters/Model10.vrm" },
  { id: "model20", name: "Model 20", url: "characters/Model20.vrm" },
  { id: "model21", name: "Model21", url: "characters/Model21.vrm" },
  { id: "model28", name: "Model 28", url: "characters/Model28.vrm" },
  { id: "orochix", name: "Orochi X", url: "characters/OrochiX.vrm" },
  { id: "shadow", name: "Shadow", url: "characters/Shadow.vrm" },
  { id: "thorn", name: "Thorn", url: "characters/Thorn.vrm" },
  { id: "violet", name: "Violet", url: "characters/Violet.vrm" },
);
