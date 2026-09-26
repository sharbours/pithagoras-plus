# Avatar Lab (portal build)

The voice stage shows this page in an iframe at `/avatar/index.html?embed=1`. Open
`/avatar/` directly (same portal address) to pick the character, framing and
background; the embedded view reuses those choices. In the embedded view a small
gear button (bottom-left) opens the same picker, so the choice can be made from
the voice stage itself without leaving it.

- `characters/*.vrm` are not committed (they're large binaries). Copy them into
  `characters/` and list them in `characters.js`. A `.vrm` loaded with the page's
  "Load .vrm file" button is remembered in the browser instead and needs no
  listing.
- `backgrounds/*.jpg` and `backgrounds.js` **are** committed (they're small):
  each background is listed in `backgrounds.js` (id, name, url) and served
  same-origin. Picking one is remembered; "None" returns to the built-in
  gradient; an uploaded image is remembered in the browser instead.
- The 3D stack (`avatar-libs.js`, ~1.7 MB) is loaded lazily the first time a
  `.vrm` character is picked, so the built-in 2D character never pays for it.
  The 2D character stays on screen while a 3D model loads, then crossfades in.
  If WebGL is unavailable or a 3D model runs too slowly on the device, it falls
  back to the 2D character and says so (remembered per device; picking a 3D
  character again retries it). Rendering pauses while the tab is hidden.
- When the stage is small (voice stage shrinks with the terminal/panel open) a
  full-body framing is unreadable, so it switches to face framing automatically
  and back to your saved choice when it grows again.
- These files are generated from the single-file Avatar Lab by
  `split_for_portal.py`: the portal's Content-Security-Policy
  (`script-src 'self'`) blocks inline scripts, so the scripts live in
  `avatar-boot.js`, `avatar-libs.js` (three.js + three-vrm, MIT) and
  `avatar-app.js`.

Credits: three.js (MIT), @pixiv/three-vrm (MIT), Basis Universal transcoder
(Apache-2.0), meshoptimizer decoder (MIT); martial arts poses by Luminestrial
(CC BY); ballet poses by Luminestrial (Virt-A-Mate FC).
