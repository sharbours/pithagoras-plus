// Tame the guitar_playing clip: re-convert the Mixamo source with per-bone
// dampening toward the bind pose, so the erratic head-whips / leg-bounce /
// arm-jab (which reads as "electrocuted") becomes a calm standing strum.
//
//   legs  (all 8)          -> 0.0   (stand still; no bounce)
//   head + neck            -> 0.3   (gentle head motion, no 32-degree snaps)
//   torso (hips..upperChest)-> 0.5  (calm sway)
//   left arm (4)           -> 0.5   (less of the jutting/collapsing flail)
//   right arm (4)          -> 1.0   (the steady strummer — keep full)
//
// Damping = per-frame slerp(quat -> identity, t). Because every frame of the
// clip is independently re-expressed relative to the same bind, the per-frame
// deltas simply shrink by ~ the same factor; no re-derivation needed.
import { readFileSync, writeFileSync } from 'fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as THREE from 'three';

const MAP = {
  hips:'mixamorigHips', spine:'mixamorigSpine', chest:'mixamorigSpine1', upperChest:'mixamorigSpine2',
  neck:'mixamorigNeck', head:'mixamorigHead',
  leftShoulder:'mixamorigLeftShoulder', leftUpperArm:'mixamorigLeftArm', leftLowerArm:'mixamorigLeftForeArm', leftHand:'mixamorigLeftHand',
  rightShoulder:'mixamorigRightShoulder', rightUpperArm:'mixamorigRightArm', rightLowerArm:'mixamorigRightForeArm', rightHand:'mixamorigRightHand',
  leftUpperLeg:'mixamorigLeftUpLeg', leftLowerLeg:'mixamorigLeftLeg', leftFoot:'mixamorigLeftFoot', leftToes:'mixamorigLeftToeBase',
  rightUpperLeg:'mixamorigRightUpLeg', rightLowerLeg:'mixamorigRightLeg', rightFoot:'mixamorigRightFoot', rightToes:'mixamorigRightToeBase',
};
const BONES = Object.keys(MAP);
const FPS = 30;
const DAMP = {};
for (const b of BONES) {
  if (b.includes('Leg') || b.includes('Foot') || b.includes('Toes')) DAMP[b] = 0.0;
  else if (b === 'head' || b === 'neck') DAMP[b] = 0.3;
  else if (b === 'hips' || b === 'spine' || b === 'chest' || b === 'upperChest') DAMP[b] = 0.5;
  else if (b.startsWith('left')) DAMP[b] = 0.5;
  else if (b.startsWith('right')) DAMP[b] = 1.0;
  else DAMP[b] = 1.0;
}
console.log('damp factors:');
BONES.forEach(b => console.log('  ' + b.padEnd(16) + DAMP[b]));

const file = process.argv[2] || '/home/hermes/.hermes/code2/idle-animations/Guitar Playing.fbx';
const g = new FBXLoader().parse(readFileSync(file).buffer.slice(0), '');
const bm = {}; g.traverse(o => { if (o.isBone) bm[o.name] = o; });
g.updateMatrixWorld(true);
const bindW = {}; BONES.forEach(b => { bm[MAP[b]].updateWorldMatrix(true, false); bindW[b] = new THREE.Quaternion().setFromRotationMatrix(bm[MAP[b]].matrixWorld).normalize().clone(); });
const hipsB = bm[MAP.hips]; hipsB.updateMatrixWorld(true, false);
const bindHips = new THREE.Vector3().setFromMatrixPosition(hipsB.matrixWorld);
const ankle = bm[MAP.leftFoot]; ankle.updateMatrixWorld(true, false);
const legLen = Math.max(0.1, Math.abs(bindHips.y - new THREE.Vector3().setFromMatrixPosition(ankle.matrixWorld).y));

const clip = g.animations[0];
const dur = clip.duration;
let frames = Math.max(2, Math.round(dur * FPS) + 1);
const mixer = new THREE.AnimationMixer(g);
const action = mixer.clipAction(clip); action.play(); action.clampWhenFinished = false;
const q = new Int16Array(frames * BONES.length * 4);
const off = new Int16Array(frames * 2);
// hip travel also damped 0.5 (calmer weight shifts)
const offDamp = 0.5;
const clampI16 = v => { v = Math.round(v); return Math.max(-32767, Math.min(32767, v)); };
// damp toward bind: DAMP = fraction of motion KEPT, so slerp t = 1-DAMP toward identity
const dampTo = (from, keep) => from.clone().slerp(new THREE.Quaternion(0, 0, 0, 1), 1 - keep);

for (let i = 0; i < frames; i++) {
  const t = Math.min(dur, i / FPS);
  mixer.setTime(t); g.updateMatrixWorld(true);
  const hp = new THREE.Vector3().setFromMatrixPosition(hipsB.matrixWorld);
  off[i * 2] = clampI16((hp.x - bindHips.x) / legLen * 16000 * offDamp);
  off[i * 2 + 1] = clampI16((hp.z - bindHips.z) / legLen * 16000 * offDamp);
  for (let b = 0; b < BONES.length; b++) {
    const node = bm[MAP[BONES[b]]];
    node.updateWorldMatrix(true, false);
    const w = new THREE.Quaternion().setFromRotationMatrix(node.matrixWorld).normalize();
    const bi = bindW[BONES[b]];
    let rx = bi.y * w.z - bi.z * w.y + bi.w * w.x,
        ry = bi.z * w.x - bi.x * w.z + bi.w * w.y,
        rz = bi.x * w.y - bi.y * w.x + bi.w * w.z,
        rw = bi.x * w.x + bi.y * w.y + bi.z * w.z + bi.w * w.w;
    const n = Math.hypot(rx, ry, rz, rw) || 1;
    let sx = rx / n, sy = ry / n, sz = rz / n, sw = rw / n;
    if (sw < 0) { sx = -sx; sy = -sy; sz = -sz; sw = -sw; }
    // damp toward bind
    const qv = new THREE.Quaternion(sx, sy, sz, sw);
    const d = dampTo(qv, DAMP[BONES[b]]);
    let dx = d.x, dy = d.y, dz = d.z, dw = d.w;
    if (dw < 0) { dx = -dx; dy = -dy; dz = -dz; dw = -dw; }
    const o = (i * BONES.length + b) * 4;
    q[o] = clampI16(dx * 32767); q[o + 1] = clampI16(dy * 32767); q[o + 2] = clampI16(dz * 32767); q[o + 3] = clampI16(dw * 32767);
  }
}
const b64 = arr => { const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); return Buffer.from(u).toString('base64'); };
const out = {
  name: 'guitar_playing', frames, fps: FPS,
  q: b64(q), off: b64(off),
  src: 'mixamo:' + file.split('/').pop() + ' (tamed)',
  _dur: +dur.toFixed(2),
};
writeFileSync('/home/hermes/.hermes/cache/scratch/fbconv/out/guitar_tamed.clip.json', JSON.stringify(out));
console.log('\nWrote tamed clip:', frames, 'frames,', (out.q.length / 1024).toFixed(0), 'KB q,', (out.off.length / 1024).toFixed(0), 'KB off');
