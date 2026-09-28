import sys, json, base64, numpy as np
sys.path.insert(0, '/home/claude/exlib')
from prmd import load, centres, unit, NAMES
BONES = ["hips", "spine", "chest", "upperChest", "neck", "head",
         "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand", "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
         "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes", "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes"]
def mat_from(a, b, a0, b0):
    """Rotation taking rest axes (a0 primary, b0 secondary) onto target axes (a, b projected off a)."""
    b = unit(b - a * np.sum(a * b, -1, keepdims=True)); c = np.cross(a, b)
    b0 = b0 - a0 * np.dot(a0, b0); b0 /= np.linalg.norm(b0); c0 = np.cross(a0, b0)
    T = np.stack([a, b, c], -1); R0 = np.stack([a0, b0, c0], -1)
    return T @ R0.T
def frame_mat(f):                                   # (lat, up, fwd) -> columns x, y, z
    return np.stack([f[0], f[1], f[2]], -1)
def quat(R):
    q = np.zeros(R.shape[:-2] + (4,)); tr = R[..., 0, 0] + R[..., 1, 1] + R[..., 2, 2]
    for i in range(len(R)):
        m = R[i]; t = tr[i]
        if t > 0: s = np.sqrt(t + 1) * 2; q[i] = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
        else:
            k = int(np.argmax([m[0, 0], m[1, 1], m[2, 2]])); j, l = (k + 1) % 3, (k + 2) % 3
            s = np.sqrt(1 + m[k, k] - m[j, j] - m[l, l]) * 2; v = [0, 0, 0]; v[k] = s / 4; v[j] = (m[j, k] + m[k, j]) / s; v[l] = (m[l, k] + m[k, l]) / s
            q[i] = [v[0], v[1], v[2], (m[l, j] - m[j, l]) / s]
    for i in range(1, len(q)):                     # keep hemispheres continuous for interpolation
        if np.dot(q[i], q[i - 1]) < 0: q[i] = -q[i]
    return q
def slerp_mat(R, t):                                # fractional rotation R^t (axis-angle scaling)
    out = np.zeros_like(R)
    for i in range(len(R)):
        m = R[i]; ang = np.arccos(np.clip((np.trace(m) - 1) / 2, -1, 1))
        if ang < 1e-6: out[i] = np.eye(3); continue
        ax = np.array([m[2, 1] - m[1, 2], m[0, 2] - m[2, 0], m[1, 0] - m[0, 1]]) / (2 * np.sin(ang))
        K = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]]); a = ang * t
        out[i] = np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K
    return out
def smooth(x, k=7):
    pad = np.concatenate([np.repeat(x[:1], k, 0), x, np.repeat(x[-1:], k, 0)]); ker = np.ones(k) / k
    return np.apply_along_axis(lambda c: np.convolve(c, ker, 'same'), 0, pad)[k:-k]

def convert(m, s, reps=2, fps=30):
    P = load(m, s)
    P = smooth(P.reshape(len(P), -1)).reshape(P.shape)
    J0 = centres(P[:40]); fwd0 = J0["pelvis_frame"][2].mean(0); yaw = np.arctan2(fwd0[0], fwd0[2])
    c, s_ = np.cos(-yaw), np.sin(-yaw); Ry = np.array([[c, 0, s_], [0, 1, 0], [-s_, 0, c]])       # face +Z
    P = P @ Ry.T
    J = centres(P); N = len(P)
    # --- repetitions: activity = mean distance of all markers from the standing start
    dev = np.linalg.norm(P - P[:40].mean(0), axis=2).mean(1); dev = smooth(dev[:, None], 25)[:, 0]
    # the ten strongest peaks at least ~half a repetition apart; loop between the low points around two of them
    sep = int(N / 10 * .55); cand = [i for i in range(1, N - 1) if dev[i] >= dev[i - 1] and dev[i] >= dev[i + 1]]
    peaks = []
    for i in sorted(cand, key=lambda i: -dev[i]):
        if all(abs(i - p) >= sep for p in peaks): peaks.append(i)
        if len(peaks) == 10: break
    peaks.sort(); k0 = max(1, len(peaks) // 2 - 1)
    lowpt = lambda p0, p1: p0 + int(np.argmin(dev[p0:p1 + 1]))
    a = lowpt(peaks[k0 - 1], peaks[k0]); last = k0 + reps - 1
    b = lowpt(peaks[last], peaks[last + 1]) if last + 1 < len(peaks) else N - 1
    reps_ = peaks
    # --- bone world rotations
    Rp = frame_mat(J["pelvis_frame"]); Rt = frame_mat(J["thorax_frame"]); Rh = frame_mat(J["head_frame"])
    cal = lambda R: R @ np.linalg.inv(R[:40].mean(0) if False else R[20])[None]        # relative to the standing start
    Rp, Rt, Rh = cal(Rp), cal(Rt), cal(Rh)
    rel = np.einsum('nji,njk->nik', Rp, Rt)                                              # pelvis -> thorax
    W = {"hips": Rp, "spine": Rp @ slerp_mat(rel, 1 / 3), "chest": Rp @ slerp_mat(rel, 2 / 3), "upperChest": Rt}
    relh = np.einsum('nji,njk->nik', Rt, Rh); W["neck"] = Rt @ slerp_mat(relh, .5); W["head"] = Rh
    X, Y, Z = np.eye(3)
    for side, sx, S in (("left", 1, "L"), ("right", -1, "R")):
        W[side + "Shoulder"] = Rt
        ua = unit(J[S + "elbow"] - J[S + "shoulder"]); fa = unit(J[S + "wrist"] - J[S + "elbow"]); hd = unit(J[S + "fin"] - J[S + "wrist"])
        bend = fa - ua * np.sum(fa * ua, -1, keepdims=True); bl = np.linalg.norm(bend, axis=-1)
        fallback = J["thorax_frame"][2]; bdir = np.zeros_like(ua); prev = fallback[0]
        for i in range(N):                                                               # elbow bend sets upper-arm twist; hold it when straight
            if bl[i] > .25: prev = bend[i] / bl[i]
            elif bl[i] > .08: w = (bl[i] - .08) / .17; prev = unit(w * bend[i] / bl[i] + (1 - w) * prev)
            bdir[i] = prev
        W[side + "UpperArm"] = np.array([mat_from(ua[i], bdir[i], sx * X, Z) for i in range(N)])
        W[side + "LowerArm"] = np.array([mat_from(fa[i], J[S + "wristbar"][i], sx * X, Z) for i in range(N)])
        W[side + "Hand"] = np.array([mat_from(hd[i], J[S + "wristbar"][i], sx * X, Z) for i in range(N)])
        th = unit(J[S + "knee"] - J[S + "hip"]); sh = unit(J[S + "ankle"] - J[S + "knee"]); ft = unit(J[S + "toe"] - J[S + "heel"])
        kb = sh - th * np.sum(sh * th, -1, keepdims=True); kl = np.linalg.norm(kb, axis=-1); pf = J["pelvis_frame"][2]
        back = np.array([kb[i] / kl[i] if kl[i] > .2 else unit(-pf[i] * (1 - kl[i] / .2) + (kb[i] / max(kl[i], 1e-9)) * (kl[i] / .2)) for i in range(N)])
        W[side + "UpperLeg"] = np.array([mat_from(th[i], back[i], -Y, -Z) for i in range(N)])
        W[side + "LowerLeg"] = np.array([mat_from(sh[i], ft[i], -Y, Z) for i in range(N)])
        fup = unit(J[S + "ankle"] - J[S + "heel"])
        W[side + "Foot"] = np.array([mat_from(ft[i], fup[i], Z, Y) for i in range(N)]); W[side + "Toes"] = W[side + "Foot"]
    # --- cut, resample to fps, root offset
    idx = np.linspace(a, b, int((b - a) / 100 * fps) + 1)
    lo = np.floor(idx).astype(int); fr = idx - lo; hi = np.minimum(lo + 1, N - 1)
    Q = []
    for n in BONES:
        q = quat(W[n]); qi = q[lo] * (1 - fr)[:, None] + q[hi] * fr[:, None]; Q.append(qi / np.linalg.norm(qi, axis=1, keepdims=True))
    Q = np.stack(Q, 1)                                                                    # frames x bones x 4
    hm = J["hipmid"]; off = (hm[lo] * (1 - fr)[:, None] + hm[hi] * fr[:, None])[:, [0, 2]] - hm[a, [0, 2]]
    leg = np.linalg.norm(J["Lhip"][20] - J["Lknee"][20]) + np.linalg.norm(J["Lknee"][20] - J["Lankle"][20])
    return Q, off / leg, (a, b, len(reps_)), leg
def pack(Q, off):
    q16 = np.round(Q.reshape(len(Q), -1) * 32767).astype('<i2'); o16 = np.round(np.clip(off, -2, 2) * 16000).astype('<i2')
    return base64.b64encode(q16.tobytes()).decode(), base64.b64encode(o16.tobytes()).decode()
if __name__ == "__main__":
    CHOICE = {1: 1, 2: 1, 3: 5, 4: 1, 6: 1, 7: 1, 8: 2, 9: 1, 10: 1}                   # clean takes; sit-to-stand (5) needs a chair
    lib = {"_bones": BONES, "_fps": 30, "_source": "UI-PRMD (University of Idaho), ODC Public Domain Dedication and License 1.0"}
    for m, s in CHOICE.items():
        Q, off, (a, b, nreps), leg = convert(m, s)
        qs, os_ = pack(Q, off); lib[NAMES[m]] = {"frames": len(Q), "q": qs, "off": os_, "src": f"m{m:02d}_s{s:02d}"}
        print(f"{NAMES[m]:20s} s{s:02d} reps found {nreps:2d} | clip {(b - a) / 100:5.1f}s {len(Q)} frames | {len(qs) // 1024} KB")
    open('/home/claude/exlib/exercises.json', 'w').write(json.dumps(lib))
