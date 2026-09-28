"""UI-PRMD Vicon (Plug-in Gait markers) -> joint centres and segment frames, in VRM axes (metres, +X left, +Y up, +Z forward)."""
import numpy as np
ROOT = "/home/claude/prmd/Movements/Vicon/Positions"
M = dict(LFHD=0, RFHD=1, LBHD=2, RBHD=3, C7=4, T10=5, CLAV=6, STRN=7, RBAK=8,
         LSHO=9, LUPA=10, LELB=11, LFRM=12, LWRA=13, LWRB=14, LFIN=15,
         RSHO=16, RUPA=17, RELB=18, RFRM=19, RWRA=20, RWRB=21, RFIN=22,
         LASI=23, RASI=24, LPSI=25, RPSI=26, LTHI=27, LKNE=28, LTIB=29, LANK=30, LHEE=31, LTOE=32,
         RTHI=33, RKNE=34, RTIB=35, RANK=36, RHEE=37, RTOE=38)
NAMES = {1: "deep_squat", 2: "hurdle_step", 3: "inline_lunge", 4: "side_lunge", 5: "sit_to_stand", 6: "straight_leg_raise",
         7: "shoulder_abduction", 8: "shoulder_extension", 9: "shoulder_rotation", 10: "scaption"}
def load(m, s):
    P = np.loadtxt(f"{ROOT}/m{m:02d}_s{s:02d}_positions.txt").reshape(-1, 39, 3) / 1000.0
    return P[..., [1, 2, 0]]                       # data x fwd, y left, z up  ->  VRM x left, y up, z fwd
unit = lambda v: v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)
def centres(P):
    g = lambda n: P[:, M[n]]
    J = {}
    mA = (g("LASI") + g("RASI")) / 2; mP = (g("LPSI") + g("RPSI")) / 2
    lat = unit(g("LASI") - g("RASI")); fwd = unit(mA - mP); fwd = unit(fwd - lat * np.sum(fwd * lat, -1, keepdims=True)); up = np.cross(fwd, lat)
    PW = np.linalg.norm(g("LASI") - g("RASI"), axis=-1)[:, None]
    J["pelvis_frame"] = (lat, up, fwd)
    for s, sg in (("L", 1), ("R", -1)):                                  # Davis-style hip joint centre
        J[s + "hip"] = mA - fwd * .19 * PW + lat * sg * .36 * PW - up * .30 * PW
        J[s + "knee"] = g(s + "KNE") - lat * sg * .05
        J[s + "ankle"] = g(s + "ANK") - lat * sg * .035
        J[s + "heel"], J[s + "toe"] = g(s + "HEE"), g(s + "TOE")
    J["hipmid"] = (J["Lhip"] + J["Rhip"]) / 2
    tup = unit((g("C7") + g("CLAV")) / 2 - (g("T10") + g("STRN")) / 2); tfw = unit((g("CLAV") + g("STRN")) / 2 - (g("C7") + g("T10")) / 2)
    tfw = unit(tfw - tup * np.sum(tfw * tup, -1, keepdims=True)); J["thorax_frame"] = (np.cross(tup, tfw), tup, tfw)
    J["neckbase"] = (g("C7") + g("CLAV")) / 2
    hc = (g("LFHD") + g("RFHD") + g("LBHD") + g("RBHD")) / 4; hl = unit((g("LFHD") + g("LBHD")) / 2 - (g("RFHD") + g("RBHD")) / 2)
    hf = unit((g("LFHD") + g("RFHD")) / 2 - (g("LBHD") + g("RBHD")) / 2); hf = unit(hf - hl * np.sum(hf * hl, -1, keepdims=True))
    J["head_frame"] = (hl, np.cross(hf, hl), hf); J["headc"] = hc
    for s in "LR":
        J[s + "shoulder"] = g(s + "SHO") - tup * .045
        J[s + "elbow"] = g(s + "ELB")
        J[s + "wrist"] = (g(s + "WRA") + g(s + "WRB")) / 2
        J[s + "wristbar"] = unit(g(s + "WRA") - g(s + "WRB"))           # ulnar -> radial (thumb side)
        J[s + "fin"] = g(s + "FIN")
    return J
