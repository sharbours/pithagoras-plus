# Avatar Lab in the voice stage

The voice stage's avatar slot shows a 3D VRM character (Avatar Lab) instead of the orb. A button
next to "End voice mode" switches between avatar and orb; the choice is remembered per browser.

## How it connects (no new server, stream or bridge)

- `web/public/avatar/` is a static page, built into `web/dist/avatar/` and served same-origin.
  The stage embeds it as `/avatar/index.html?embed=1` (character only, transparent background).
- `web/src/components/AvatarFrame.tsx` drives it with `postMessage`:
  - **state** from the voice phase: `Listening` → idle; `Hearing you` / `Transcribing` → listening
    (eyes on the user); `Thinking` / `Compacting context` → thinking face; playback → speaking.
  - **mouth**: the RMS level of the speech actually playing (`levels.current.output`, measured by the
    existing playback analyser) about 30×/s, so lip sync follows the real Kokoro audio.
  - **cues**: the avatar tags of each sentence, sent when that sentence's audio starts.
- `web/src/avatar-tags.ts`: tags such as `[happy]`, `[wave]`, `[pose:horse]`, `[expr:Name]` are
  removed before TTS (`VoiceControl.synthesize`) and from the voice transcript
  (`displaySpeechText`). Only known names count as tags, so `[1]` or `[sic]` are left alone.
  Mid-sentence tags fire at their proportional point in the sentence's playback.
- The existing speech cues `(laugh)`, `(sigh)`, `(cough)`, `(clears throat)` still go to TTS
  unchanged; the avatar also reacts to them (giggle, sigh, look down).
- `server/src/pi/voice-first.ts`: one short paragraph added to the voice-mode rule so both brains
  (local Qwen and Hermes via the bridge) know the tags. `AVATAR_TAGS=false` removes it.

## Choosing the character

Open `https://<portal>/avatar/` directly: pick a character, framing (Upper body / Full body) and
background image there. The embedded view reuses the choices (localStorage + IndexedDB, same origin).
A `.vrm` loaded with "Load .vrm file" is kept in the browser. Listed characters come from
`web/public/avatar/characters.js`; put their `.vrm` files in `web/public/avatar/characters/`
(git-ignored).

## Security policy

The portal's CSP is `script-src 'self' 'wasm-unsafe-eval'`, which forbids inline scripts. The
portal copy of Avatar Lab is therefore split into `index.html` + `avatar-boot.js`,
`avatar-libs.js`, `avatar-app.js` with no inline code; it was tested under the portal's exact
header with zero violations (KTX2's WebAssembly decoder and blob: worker are allowed by it).
Google Fonts are outside the policy, so the page uses system fonts.

## Before rebuilding the production (compact-prod) image

`compact-build/override-*.ts` are Sep 15 snapshots that the Dockerfile copies over
`web/src/api.ts`, `web/src/components/Chat.tsx` and `server/src/index.ts`. This change does not
touch those three files, but rebuilding from this tree with the overrides still in place would drop
newer upstream features and the approvals UI. Refresh or remove the override step first.
Test in the dev setup (`npm run dev`) before building the image.
