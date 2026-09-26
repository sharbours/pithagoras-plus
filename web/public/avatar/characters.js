// Characters listed in the avatar's picker. Served by the portal, so plain .vrm files work by URL.
// Put the .vrm files in ./characters/ (they are git-ignored; see README.md in this folder).
window.AVATAR_CHARACTERS = window.AVATAR_CHARACTERS || [];
window.AVATAR_CHARACTERS.push(
  { id: "seed-san", name: "Seed-san (simple)", url: "characters/seed-san.vrm",
    credit: "Seed-san by VirtualCast, Inc. Used under the VRM Public License 1.0 (vrm.dev/licenses/1.0)" },
  { id: "avatar-sample-b", name: "AvatarSample_B (complex)", url: "characters/avatar-sample-b.vrm",
    credit: "AvatarSample_B by pixiv Inc. (VRoid Project), VRM Public License 1.0" }
);
