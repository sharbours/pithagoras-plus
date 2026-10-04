// Convert one mixamo FBX to the library.js clip format (22-bone, 30fps,
// world-quat-relative-to-bind int16 + hip travel). Prints a per-bone raw-key
// motion profile so you can judge whether the source needs damping (see
// tame-guitar.mjs) before splicing it into web/public/avatar/library.js.
//
// Usage:  node tools/mixamo/convert-one.mjs /path/to/SomeMotion.fbx
// Output: out/<Name>.clip.json — {frames, q, off, src} ready to splice as a
// new "name_here" entry in library.js (see README).
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as THREE from 'three';

const DIR = '/home/hermes/.hermes/code2/idle-animations/';
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
const MAX_FRAMES = 3000;

// classification
const IDLE = new Set(['Drunk Idle','Dwarf Idle','Offensive Idle','Standing Arguing','Talking','Thinking','Weight Shift','Looking Around','Looking Behind','Treadmill Running','Bored','Batter On Deck']);
const EXERCISE = new Set(['Jumping Jacks','Jumping Rope','Front Raises','Kettlebell Swing','Neck Stretching','Pulling A Rope','Speedbag','Situps','Button Pushing','Stomp','Check Shoe']);
const DANCE = new Set(['Bellydancing','Chicken Dance','Hip Hop Dancing','Silly Dancing','Tut Hip Hop Dance','Ymca Dance','Backflip','Superhuman Choke Lift']);
// true static poses: only the 6 ~2-frame Female pose cards
const POSE = new Set(['Female Standing Pose','Female Standing Pose (1)','Female Standing Pose (2)','Female Standing Pose (3)','Female Standing Pose (4)','Female Dance Pose']);
// multi-second "pose-ish" motions that are really animations
const GHOST = new Set(['Cards','Guitar Playing','Texting','Texting While Standing','Using A Filing Cabinet']);
// everything not in the above = gesture
function classify(name){
  if (IDLE.has(name)) return 'idle';
  if (EXERCISE.has(name)) return 'exercise';
  if (DANCE.has(name)) return 'dance';
  if (POSE.has(name)) return 'pose';
  return 'gesture';
}

function toWorldQuat(node, out=new THREE.Quaternion()){ node.updateWorldMatrix(true,false); return out.setFromRotationMatrix(node.matrixWorld).normalize(); }
function toWorldPos(node, out=new THREE.Vector3()){ node.updateWorldMatrix(true,false); return out.setFromMatrixPosition(node.matrixWorld); }
function b64(arr){ const u=new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); return Buffer.from(u).toString('base64'); }
function clampI16(v){ v=Math.round(v); return Math.max(-32767, Math.min(32767, v)); }

function loadFile(file){
  const buf = readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength);
  const g = new FBXLoader().parse(ab, '');
  const bm = {}; g.traverse(o=>{ if(o.isBone) bm[o.name]=o; });
  // bind
  g.updateMatrixWorld(true);
  const bindW = {}; BONES.forEach(b=> bindW[b]=toWorldQuat(bm[MAP[b]]).clone());
  const hipsB = bm[MAP.hips]; hipsB.updateWorldMatrix(true,false);
  const bindHips = new THREE.Vector3().setFromMatrixPosition(hipsB.matrixWorld);
  const ankle = bm[MAP.leftFoot]; ankle.updateWorldMatrix(true,false);
  const ankleY = new THREE.Vector3().setFromMatrixPosition(ankle.matrixWorld).y;
  const legLen = Math.max(0.1, Math.abs(bindHips.y - ankleY));
  return { g, bm, bindW, bindHips, legLen, clip: g.animations[0] };
}

function convertClip(file, cat){
  const name = file.split('/').pop().replace(/\.fbx$/i,'');
  const { g, bm, bindW, bindHips, legLen, clip } = loadFile(file);
  const dur = clip.duration;
  let frames = Math.max(2, Math.round(dur*FPS)+1);
  if (frames > MAX_FRAMES) frames = MAX_FRAMES;
  const mixer = new THREE.AnimationMixer(g);
  const action = mixer.clipAction(clip); action.play(); action.clampWhenFinished=false;

  // static pose: grab the LAST frame (most "settled") relative to the A-pose
  let staticFrame = null;
  if (cat === 'pose'){
    const t = Math.min(dur, (frames-1)/FPS);
    mixer.setTime(t); g.updateMatrixWorld(true);
    staticFrame = {};
    for (const b of BONES){
      const node = bm[MAP[b]];
      node.updateWorldMatrix(true,false);
      const w = toWorldQuat(node);
      const bi = bindW[b];
      let rx = bi.y*w.z - bi.z*w.y + bi.w*w.x,
          ry = bi.z*w.x - bi.x*w.z + bi.w*w.y,
          rz = bi.x*w.y - bi.y*w.x + bi.w*w.z,
          rw = bi.x*w.x + bi.y*w.y + bi.z*w.z + bi.w*w.w;
      const n = Math.hypot(rx,ry,rz,rw)||1;
      let sx=rx/n,sy=ry/n,sz=rz/n,sw=rw/n;
      if(sw<0){sx=-sx;sy=-sy;sz=-sz;sw=-sw;}
      staticFrame[b] = [Math.round(sx*32767), Math.round(sy*32767), Math.round(sz*32767), Math.round(sw*32767)];
    }
    const hp = new THREE.Vector3().setFromMatrixPosition(bm[MAP.hips].matrixWorld);
    const drop = clampI16((hp.y - bindHips.y)/legLen * 16000)/16000;
    return { name, frames, fps:FPS, cat, staticFrame, drop, _dur: +dur.toFixed(2), src:'mixamo:'+file.split('/').pop() };
  }

  // animated clip: per-frame A-pose-relative world quats (int16) + hip travel
  const q = new Int16Array(frames * BONES.length * 4);
  const off = new Int16Array(frames * 2);
  for(let i=0;i<frames;i++){
    const t = Math.min(dur, i/FPS);
    mixer.setTime(t); g.updateMatrixWorld(true);
    const hipsB2 = bm[MAP.hips]; hipsB2.updateWorldMatrix(true,false);
    const hp = new THREE.Vector3().setFromMatrixPosition(hipsB2.matrixWorld);
    off[i*2] = clampI16((hp.x - bindHips.x)/legLen*16000);
    off[i*2+1] = clampI16((hp.z - bindHips.z)/legLen*16000);
    for(let b=0;b<BONES.length;b++){
      const node = bm[MAP[BONES[b]]];
      node.updateWorldMatrix(true,false);
      const w = toWorldQuat(node);
      const bi = bindW[BONES[b]];
      let rx=bi.y*w.z-bi.z*w.y+bi.w*w.x, ry=bi.z*w.x-bi.x*w.z+bi.w*w.y, rz=bi.x*w.y-bi.y*w.x+bi.w*w.z, rw=bi.x*w.x+bi.y*w.y+bi.z*w.z+bi.w*w.w;
      const n=Math.hypot(rx,ry,rz,rw)||1;
      let sx=rx/n,sy=ry/n,sz=rz/n,sw=rw/n;
      if(sw<0){sx=-sx;sy=-sy;sz=-sz;sw=-sw;}
      const o=(i*BONES.length+b)*4;
      q[o]=Math.round(sx*32767); q[o+1]=Math.round(sy*32767); q[o+2]=Math.round(sz*32767); q[o+3]=Math.round(sw*32767);
    }
  }
  return { name, frames, fps:FPS, cat, q: b64(q), off: b64(off), src:'mixamo:'+file.split('/').pop(), _dur: +dur.toFixed(2) };
}


// main
const file = process.argv[2];
if (!file) { console.error('usage: node convert-wave.mjs <file.fbx>'); process.exit(2); }
const name = file.split('/').pop().replace(/\.fbx$/i, '');
const cat = 'gesture';
const full = file.startsWith('/') ? file : DIR + file;
const c = convertClip(full, cat);

// raw-key per-bone analysis
const g2 = new FBXLoader().parse(readFileSync(full).buffer.slice(0), '');
const clip = g2.animations[0];
const ang = (a,b) => { let d = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]; d=Math.max(-1,Math.min(1,d)); return 2*Math.acos(Math.abs(d))*57.3; };
console.log('== raw-key per-bone motion (deg) ==');
for (const b of BONES) {
  const tr = clip.tracks.find(t => t.name === MAP[b] + '.quaternion');
  if (!tr) continue;
  const v = tr.values;
  let maxD = 0, sum = 0;
  for (let i = 1; i < v.length/4; i++) {
    const a=[v[(i-1)*4],v[(i-1)*4+1],v[(i-1)*4+2],v[(i-1)*4+3]];
    const cc=[v[i*4],v[i*4+1],v[i*4+2],v[i*4+3]];
    const d=ang(a,cc); if(d>maxD)maxD=d; sum+=d;
  }
  if (sum > 1) console.log('  ' + b.padEnd(15) + String(tr.times.length).padStart(4) + ' keys | max ' + maxD.toFixed(1) + '° | total ' + sum.toFixed(0) + '°');
}
console.log('== converted ==');
console.log('frames', c.frames, 'dur', c._dur + 's');

const out = { _bones: BONES, _fps: FPS, gestures: {} };
c.loops = 1;
out.gestures[name] = c;
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/' + name + '.clip.json', import.meta.url), JSON.stringify(out.gestures[name]));
console.log('wrote tools/mixamo/out/' + name + '.clip.json');
