# Mixamo clip tamers

Byte-surgery scripts that re-convert a Mixamo FBX into a calmer clip when the
source animation is more "performance" than we want (props-less standing avatars
read full-body flail as glitching). Pattern: re-convert the source with per-bone
damping toward the bind pose, then splice the result into the generated
`web/public/avatar/library.js` clip entry (same format, so it drops in 1:1).

These are **not** part of the build; run them manually and re-run
`tools/.../genlib` (or splice by hand) to regenerate the shipped library.

| Script | Target clip | What it does |
|---|---|---|
| `convert-one.mjs` | any single FBX | Converts one mixamo FBX to the library clip format and prints a per-bone raw-key motion profile (how to judge if it needs taming). Output: `out/<Name>.clip.json` — splice into `library.js`. |
| `tame-guitar.mjs` | `guitar_playing` | legs locked (0.0), head/neck 0.3, torso 0.5, left arm 0.5, right arm 1.0; hips travel 0.5x. Makes the Mixamo "Guitar Playing" full-body performance read as a calm standing strum. |

Usage (needs `three` — `npm i three` in a scratch dir; not a repo dep on purpose):

    node tools/mixamo/convert-one.mjs /path/to/SomeMotion.fbx
    node tools/mixamo/tame-guitar.mjs /path/to/idle-animations/Guitar\ Playing.fbx

Output: `out/guitar_tamed.clip.json` next to the script — splice its
`{frames,q,off,src}` into the `guitar_playing` entry of
`web/public/avatar/library.js` (see the generator at
`/home/hermes/.hermes/cache/scratch/fbconv/genlib.mjs` for the exact line shape).

Why (2026-10-04, build #50): the raw Mixamo keys proved the clip is a 6.2s
full-body performance — both hands ~350-416 deg total path, head 32 deg/key
snaps, legs 240-284 deg — which with no guitar prop looked like "electrocuted"
flailing to the user. Taming keeps the hands (right arm = strummer, full) and
kills the whips/bounce. Verified: original max whole-body frame delta 466 deg /
46 frames >20 deg; tamed 213 deg / 10 frames, lower body 0 deg, head+neck 518->262.
