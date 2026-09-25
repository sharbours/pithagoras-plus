#!/usr/bin/env python3
"""Deploy the double-TTS fix (SpeakReplies yields to voice mode; source-tagged
TTS log line) to .210: test :8443 first, then prod :443.
Files: web/src/components/SpeakReplies.tsx, web/src/components/Chat.tsx,
web/src/components/VoiceControl.tsx, compact-build/override-web-Chat.tsx,
server/src/api/voice.ts."""
import json, os, subprocess, sys, time, hashlib

ROOT = "/opt/pithagoras"
BAK = f"{ROOT}/backup/double-tts-20260919"
NEW = {
    f"{ROOT}/web/src/components/SpeakReplies.tsx": "SpeakReplies.live.tsx",
    f"{ROOT}/web/src/components/Chat.tsx": "Chat.live.tsx",
    f"{ROOT}/web/src/components/VoiceControl.tsx": "VoiceControl.live.tsx",
    f"{ROOT}/compact-build/override-web-Chat.tsx": "override-web-Chat.tsx",
    f"{ROOT}/server/src/api/voice.ts": "voice.ts.live",
}
LOCAL = os.path.dirname(os.path.abspath(__file__)) + "/pith-src-live/"

def sh(args, check=True, timeout=3600):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        print("FAILED:", " ".join(args)[:200]); print((r.stderr or r.stdout)[-2000:])
        raise SystemExit(1)
    return r

def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()

def read(p):
    with open(p) as f: return f.read()

# ---- 1. backups (host originals, first time only) ----
sh(["mkdir", "-p", BAK])
for dst in NEW:
    base = os.path.basename(dst)
    tag = dst.replace(ROOT + "/", "").replace("/", "__")
    bakp = f"{BAK}/{tag}"
    if not os.path.exists(bakp):
        sh(["cp", "-n", dst, bakp])
    print("1. backed up:", tag)

# ---- 2. push new sources (md5-verified) ----
for dst, src in NEW.items():
    content = read(LOCAL + src)
    open(dst, "w").write(content)
    got = md5(dst)
    want = hashlib.md5(content.encode()).hexdigest()
    assert got == want, f"md5 mismatch {dst}: {got} != {want}"
    print("2. pushed + md5 ok:", dst)

# ---- 3. rebuild TEST image (main Dockerfile) ----
t0 = time.time()
sh(["docker", "build", "-t", "pithagoras-portal:compact-test", ROOT], timeout=3600)
print("3. test image rebuilt in %.0fs" % (time.time() - t0))

# ---- 4. recreate test container (same spec, password 'password') ----
NAME = "testing-pithagoras-perm"
spec = json.loads(sh(["docker", "inspect", NAME]).stdout)[0]
env = [e for e in spec["Config"]["Env"] if not e.startswith("PORTAL_PASSWORD=")]
env.append("PORTAL_PASSWORD=password")
run = ["docker", "run", "-d", "--name", NAME, "--restart", "no", "--network",
       spec["HostConfig"].get("NetworkMode", "default")]
for e in env: run += ["-e", e]
for m in spec.get("Mounts", []):
    mode = f":{m['Mode']}" if m.get("Mode") else ""
    srcm = m["Source"] if m["Type"] == "bind" else m["Name"]
    run += ["-v", f"{srcm}:{m['Destination']}{mode}"]
run.append("pithagoras-portal:compact-test")
sh(["docker", "stop", NAME]); sh(["docker", "rm", NAME])
print("4. test container recreated:", sh(run).stdout.strip()[:12])

# ---- 5. verify test portal ----
up = False
for _ in range(30):
    time.sleep(1)
    if sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8443/"], check=False).stdout.strip() == "200":
        up = True; break
code = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
           "http://127.0.0.1:8443/api/auth/login", "-H", "Content-Type: application/json",
           "-d", json.dumps({"password": "password"})], check=False).stdout.strip()
dist = sh(["docker", "exec", NAME, "sh", "-c",
           "cat /app/web/dist/assets/*.js /app/web/dist/assets/*.css 2>/dev/null"], check=False).stdout
mark = all(x in dist for x in ("pith-voice-gate", "voice-status-stack", "compact-newchat", "compact-toggle"))
srcmark = 'speak-replies' in dist  # source tag string in bundle
srvlog = "[voice/speech] session=" in open(f"{ROOT}/server/src/api/voice.ts").read()
print(f"5. TEST  up={up} login={code} bundle-markers={mark} source-tag-in-bundle={srcmark} server-log-line={srvlog}")
ok1 = up and code == "200" and mark and srcmark and srvlog

# ---- 6. rebuild PROD image via compact-build Dockerfile (permission-free) ----
t0 = time.time()
sh(["docker", "build", "-f", f"{ROOT}/compact-build/Dockerfile", "-t", "pithagoras-portal:compact-prod", ROOT], timeout=3600)
print("6. prod image (compact-prod) rebuilt in %.0fs" % (time.time() - t0))

# ---- 7. recreate prod container (real spec, real secret envs preserved) ----
spec = json.loads(sh(["docker", "inspect", "pithagoras"]).stdout)[0]
env = spec["Config"]["Env"]
run = ["docker", "run", "-d", "--name", "pithagoras", "--restart",
       spec["HostConfig"].get("RestartPolicy", {}).get("Name", "unless-stopped"),
       "--network", spec["HostConfig"].get("NetworkMode", "default")]
for e in env: run += ["-e", e]
for m in spec.get("Mounts", []):
    mode = f":{m['Mode']}" if m.get("Mode") else ""
    srcm = m["Source"] if m["Type"] == "bind" else m["Name"]
    run += ["-v", f"{srcm}:{m['Destination']}{mode}"]
run.append("pithagoras-portal:compact-prod")
sh(["docker", "stop", "pithagoras"]); sh(["docker", "rm", "pithagoras"])
print("7. prod container recreated:", sh(run).stdout.strip()[:12])

# ---- 8. verify prod ----
import urllib.request, urllib.error, ssl, http.cookiejar
up = False
for _ in range(30):
    time.sleep(1)
    if sh(["curl", "-sk", "-o", "/dev/null", "-w", "%{http_code}", "https://127.0.0.1:443/"], check=False).stdout.strip() == "200":
        up = True; break
pw = [l.split("=", 1)[1].strip() for l in read(f"{ROOT}/.env").splitlines() if l.startswith("PORTAL_PASSWORD=")][0]
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj), urllib.request.HTTPSHandler(context=ctx))
try:
    lr = op.open(urllib.request.Request("https://127.0.0.1:443/api/auth/login",
        data=json.dumps({"password": pw}).encode(),
        headers={"Content-Type": "application/json"}, method="POST"))
    login = lr.status
except urllib.error.HTTPError as e:
    login = e.code
v = json.loads(op.open("https://127.0.0.1:443/api/voice").read().decode())
pdist = sh(["docker", "exec", "pithagoras", "sh", "-c",
            "cat /app/web/dist/assets/*.js /app/web/dist/assets/*.css 2>/dev/null"], check=False).stdout
pmark = all(x in pdist for x in ("pith-voice-gate", "voice-status-stack", "compact-newchat", "compact-toggle"))
pno_perm = all(x not in pdist for x in ("PermissionBar", "resolveApproval"))
psrc = 'speak-replies' in pdist
print(f"8. PROD  up={up} login={login} voice={v.get('enabled')} bundle-markers={pmark} permission-free={pno_perm} source-tag={psrc}")
ok2 = up and login == 200 and v.get("enabled") is True and pmark and pno_perm and psrc

print("RESULT:", "PASS" if (ok1 and ok2) else "CHECK")
sys.exit(0 if (ok1 and ok2) else 2)
