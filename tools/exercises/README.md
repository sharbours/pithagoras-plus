# Exercise library (UI-PRMD → Avatar Lab)

`web/public/avatar/exercises.js` holds nine exercise clips converted from the **University of Idaho Physical
Rehabilitation Movement Data (UI-PRMD)**, Vicon recordings, released under the Open Data Commons Public
Domain Dedication and License 1.0 (effectively public domain). Credit: Vakanski, Jun, Paul, Baker,
"A Data Set of Human Body Movements for Physical Rehabilitation Exercises", Data 3(1), 2018.

| Tag name | Source | Notes |
|---|---|---|
| deep_squat | m01_s01 | arms overhead (the test is done holding a dowel) |
| hurdle_step | m02_s01 | recorded arms replaced by relaxed arms |
| inline_lunge | m03_s05 | recorded arms replaced by relaxed arms |
| side_lunge | m04_s01 | recorded arms replaced by relaxed arms |
| straight_leg_raise | m06_s01 | "standing active straight leg raise"; relaxed arms |
| shoulder_abduction | m07_s01 | |
| shoulder_extension | m08_s02 | |
| shoulder_rotation | m09_s01 | "standing shoulder internal-external rotation" |
| scaption | m10_s01 | "standing shoulder scaption" |

Sit to stand (m05) is left out: without a chair the avatar would sit on air.

Use: `[exercise:deep_squat]` or `[exercise:deep_squat:4]` (loops; each loop is two repetitions),
`{"exercise": "deep_squat", "loops": 4}`, the Exercises buttons, or `[exercise:off]`.

## How the clips are made (`convert_ex.py`, `prmd.py`)

- The Vicon files are Plug-in Gait **marker** positions (39 markers, mm, z up), not joint centres.
  Joint centres are estimated (Davis-style hip centre from the pelvis markers; knee/ankle markers moved
  medially; shoulder below the shoulder marker; wrist = midpoint of the two wrist markers).
- Bone orientations: pelvis, thorax and head from their marker clusters, measured relative to the
  standing start (removes marker-placement offsets); thorax rotation spread over spine/chest/upperChest.
  Limbs from directions: upper arm twist from the elbow bend (held while the arm is straight), forearm and
  hand roll from the wrist markers, thigh twist from the knee bend (pelvis when straight), shin twist
  from the foot, foot from heel→toe.
- Each take is turned to face +Z, lightly smoothed, split into its ten repetitions by activity peaks, and
  a loop of two repetitions is cut between rest points. 30 fps, int16 quaternions (base64), plus
  horizontal hip travel as a fraction of leg length. Vertical placement comes from Avatar Lab's pose
  grounding.
- To add or swap takes, edit `CHOICE` in `convert_ex.py` (data path in `prmd.py`) and rerun.
