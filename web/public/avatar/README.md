# Avatar Lab (portal build)

The voice stage shows this page in an iframe at `/avatar/index.html?embed=1`. Open
`/avatar/` directly (same portal address) to pick the character, framing and background;
the embedded view reuses those choices.

- `characters/*.vrm` are not committed. Copy `seed-san.vrm` and `avatar-sample-b.vrm` (or your own)
  into `characters/` and list them in `characters.js`. A `.vrm` loaded with the page's
  "Load .vrm file" button is remembered in the browser instead and needs no listing.
- These files are generated from the single-file Avatar Lab by `split_for_portal.py`: the portal's
  Content-Security-Policy (`script-src 'self'`) blocks inline scripts, so the scripts live in
  `avatar-boot.js`, `avatar-libs.js` (three.js + three-vrm, MIT) and `avatar-app.js`.

Credits: three.js (MIT), @pixiv/three-vrm (MIT), Basis Universal transcoder (Apache-2.0),
meshoptimizer decoder (MIT); martial arts poses by Luminestrial (CC BY); ballet poses by
Luminestrial (Virt-A-Mate FC).
