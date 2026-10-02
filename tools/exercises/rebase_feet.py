#!/usr/bin/env python3
"""Make exercise-clip feet flat (identity foot/toe quats) by direct byte surgery.

ROOT CAUSE
  exercises.js clips store per-bone WORLD quaternions as little-endian int16
  (component / 32767), 22 bones x 4 components per frame (converter:
  convert_ex.py line 98, '<i2' native little-endian; runtime: avatar-app.js
  line 207 atob->Int16Array, line 233 k=1/32767). The app's applyPose()
  writes each quat to the matching NORMALIZED bone (line 1367); the normalized
  bone's WORLD quat therefore equals the clip quat (poseLocal's parent chain
  composes out), and the rendered raw bone = world * bind. At rest every
  normalized bone's world quat is identity (measured on 5 VRM 1.0 models), so
  at rest the rendered foot is exactly the authored flat-foot bind.

  convert_ex.py builds Foot/Toes from the capture rig's absolute frame and,
  unlike hips/spine/head, never re-references them, so every clip's foot/toe
  quats carry a large constant offset (deep_squat: left foot 68 deg, right 18
  deg, toes ~155 deg; feet even disagree with each other). Written to the
  normalized bones, that rotates the rendered foot off its flat bind: the
  sideways ankle bend / shoe-on-edge reported in squats and leg raises.
  (Earlier "follow-shin" and "pre-multiply R" rebase attempts were A/B-rejected;
  see pithagoras-210-voice-llm skill.)

FIX (this tool)
  Replace the 8-byte slot of each of the 4 foot/toe bones with the identity
  quat (0,0,0,1) as int16 at EVERY frame of EVERY clip: normalized foot world
  = identity = the rest pose -> sole flat, toes forward, no snap into/out of
  the clip, character-agnostic. Leg bones, `off` and all metadata are left
  byte-identical: knees/shins still move, the ankle simply takes the shin's
  tilt as normal dorsiflexion.

  Implementation is direct byte surgery on the base64 `q` payload (no
  decode->renormalize->re-encode round trip, which loses int16 precision and
  corrupts untouched bones). Verification: the only bytes that may differ
  from the input are the foot/toe slots; everything else must be identical.

Usage:  python3 rebase_feet.py SRC-exercises.js DST-exercises.js
"""
import base64, json, math, sys
from collections import OrderedDict

BON = ["hips","spine","chest","upperChest","neck","head",
       "leftShoulder","leftUpperArm","leftLowerArm","leftHand",
       "rightShoulder","rightUpperArm","rightLowerArm","rightHand",
       "leftUpperLeg","leftLowerLeg","leftFoot","leftToes",
       "rightUpperLeg","rightLowerLeg","rightFoot","rightToes"]
FOOT = [BON.index(n) for n in ("leftFoot","leftToes","rightFoot","rightToes")]
IDENT16 = bytes((0,0, 0,0, 0,0, 0xFF,0x7F))  # (x,y,z,w)=(0,0,0,+1) little-endian int16 — 8 bytes exactly

def i16(v):
    return int(v).to_bytes(2, "little", signed=True)

def main(src, dst):
    s = open(src).read()
    hdr_end = s.index("window.AVATAR_EXERCISES = ")
    header = s[:hdr_end + len("window.AVATAR_EXERCISES = ")]
    lib = json.loads(s[hdr_end + len("window.AVATAR_EXERCISES = "):].strip().rstrip(";"),
                     object_pairs_hook=OrderedDict)
    B = len(BON)
    assert lib["_bones"] == BON, f"unexpected bone order: {lib['_bones']}"
    for name, c in lib.items():
        if name.startswith("_"):
            continue
        F = c["frames"]
        raw = base64.b64decode(c["q"])
        assert len(raw) == F * B * 8, f"{name}: {len(raw)} != {F*B*8}"
        # report the defect removed (max deflection across the clip, foot/toes only)
        def qat(f, b):
            o = (f * B + b) * 8
            return [int.from_bytes(raw[o + 2*k:o + 2*k + 2], "little", signed=True) / 32767
                    for k in range(4)]
        worst = 0.0
        for f in range(F):
            for b in FOOT:
                q = qat(f, b)
                n = math.sqrt(sum(v*v for v in q)) or 1
                worst = max(worst, math.degrees(2 * math.acos(max(-1, min(1, abs(q[3]/n))))))
        out = bytearray(raw)
        for f in range(F):
            for b in FOOT:
                out[(f * B + b) * 8 : (f * B + b) * 8 + 8] = IDENT16
        # VERIFY: only the foot/toe slots may differ
        changed = 0
        for f in range(F):
            for b in range(B):
                seg = bytes(out[(f*B+b)*8:(f*B+b)*8+8])
                old = bytes(raw[(f*B+b)*8:(f*B+b)*8+8])
                if seg != old:
                    assert b in FOOT, f"{name} f{f} b{b} ({BON[b]}) unexpectedly modified"
                    changed += 1
        assert changed == F * len(FOOT), f"{name}: changed {changed}, expected {F*len(FOOT)}"
        c["q"] = base64.b64encode(bytes(out)).decode()
        print(f"{name:20s} frames={F:3d}  max foot/toe deflection removed: {worst:5.1f} deg  "
              f"surgery verified ({F*len(FOOT)} slots, all other bones byte-identical)")
    new = header + json.dumps(lib, separators=(",", ":")) + "\n"
    open(dst, "w").write(new)
    print(f"wrote {dst} ({len(new)} bytes)")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
