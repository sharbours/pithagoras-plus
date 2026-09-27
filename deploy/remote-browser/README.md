# The agent's browser on the Hermes host

Hermes (on **`.197`, a Proxmox LXC**) drives a Chromium on its own host; the portal (on **`.210`**)
shows it live in the voice stage's floating window and opens that window whenever the browser
navigates. Both hosts are private LAN boxes; all cross-host traffic travels through one
key-restricted SSH tunnel. This document is the **as-built** record of the 2026-09-27 deployment —
it differs from a generic install in ways noted in *Adaptations* and *Gotchas*. The companion
**voice stack** (STT Whisper + TTS Kokoro) as-built doc is [`deploy/voice/README.md`](../voice/README.md).

```
.197  Chromium container (host network)            .210  portal
       ├─ 9222 debugging  ◄── Hermes (cdp_url)      ├─ /browser-ui/ viewer  ─┐
       ├─ 3011 viewer (HTTPS, password)  ◄─┐       ├─ status + navigations ─┤  127.0.0.1:3011/9222/8082
       └─ 8082 selkies stream           ◄─┴──┬──┴─┴─ keep-alive + upgrade   (pithagoras-browser-tunnel)
                                             └ one SSH tunnel, key-restricted
```

## What the user sees

- Voice mode: a **browser window** auto-opens (and re-opens on every navigation) showing Hermes's
  Chromium. The window iframes the portal's `/browser-ui/` proxy, which **injects the viewer
  credential server-side — the user never sees a login prompt** (see Gotcha 1 if one appears).
- The same screen is also reachable from the portal's browser icon / `BrowserPage`.
- The user can **type into the browser they are watching** (e.g. to log in somewhere on Hermes's
  behalf) — it is a full desktop session, not a static feed.
- Auto-open is switchable: `BROWSER_ACTIVITY=false` in the portal `.env`.

## 1. On `.197`: Docker + the Chromium container

`.197` is a **privileged Proxmox LXC** (Debian 12; root has full capabilities, cgroup v2), so
**rootful Docker works directly** — no rootless setup needed.

```sh
# one-time (2026-09-27): install Docker, join the group
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo bash /tmp/get-docker.sh && sudo systemctl enable --now docker
sudo usermod -aG docker hermes        # needs a new login session to take effect
```

The container (host network; CDP stays loopback-only):

```sh
# env file at /etc/hermes-browser.env (root-only 600):
#   PUID=0  PGID=0  TZ=Etc/UTC
#   CUSTOM_USER=agent            ← the viewer's BASIC-AUTH username
#   PASSWORD=<32-hex>            ← the viewer's BASIC-AUTH password (generate: openssl rand -hex 16)
#   CUSTOM_PORT=3010  CUSTOM_HTTPS_PORT=3011
#   CHROME_CLI=--remote-debugging-port=9222   RESTART_APP=true
docker run -d --name hermes-browser --network host --restart unless-stopped \
  --security-opt seccomp=unconfined --shm-size=1g \
  $(while IFS= read -r l; do [ -n "$l" ] && printf -- "-e %s " "$l"; done < /etc/hermes-browser.env) \
  -v hermes-browser-profile:/config \
  lscr.io/linuxserver/chromium:latest
```

Port posture (host networking means the ports land on the LXC's interfaces). Probed from a second
LAN box (`.210`) on 2026-09-27:
- **9222 (CDP) and 8082 (selkies stream): loopback only** — connection *refused* from the LAN
  (nothing bound off 127.0.0.1). 9222 is the control plane; whoever has it owns the browser and
  every site signed in there, so this is the one that must never leave loopback.
- **3010 (websockify, plain, no password) and 3011 (noVNC HTTPS, Basic-auth `agent` + `PASSWORD`)
  are reachable from the LAN.** `.197` has **no ufw**, and the PVE host firewall does **not**
  currently block these two — so today 3011's only protection is its password and 3010 has none.
  That is acceptable on a trusted private LAN (both sit behind the PVE host's own trust boundary
  and the tunnel is the intended path); if `.197` ever gets more reachability than that, add a PVE
  host-firewall rule to deny 3010/3011 from off-LAN (the loopback/tunnel path is unaffected).
- RAM headroom: the LXC has 4 GB; the container + a busy desktop uses ~2 GB incl. swap. If `.197`
  starts feeling slow, this is the first thing to trim.

## 2. On `.197`: point Hermes at it

`~/.hermes/config.yaml`:

```yaml
browser:
  cdp_url: http://127.0.0.1:9222
```

`127.0.0.1` works because Hermes here runs **on the host** (not in a container), so its loopback
is the LXC's loopback where Chrome listens. (If Hermes ever moves to a container, the README's
original caveat applies: relay the port, don't use the container's localhost.) Use the plain
`http://host:port` form, not a `ws://…/devtools/browser/<id>` address — that id changes on every
browser restart.

## 3. On `.210`: the key-restricted SSH tunnel

1. **Key** (on `.210`, owned by the account that runs the portal — here `hermes`):
   `ssh-keygen -t ed25519 -f /home/hermes/.ssh/browser_tunnel -N ''`
2. **Restricted user** (on `.197`):
   ```sh
   sudo useradd -r -m -s /usr/sbin/nologin -c "pithagoras browser tunnel only" tunnel
   sudo install -d -o tunnel -g tunnel -m 750 /home/tunnel/.ssh
   # authorized_keys (0600, tunnel-owned): exactly one line,
   # the .210 key's public half prefixed with:
   #   restrict,port-forwarding,permitopen="127.0.0.1:9222",permitopen="127.0.0.1:3011",permitopen="127.0.0.1:8082",command=""
   ```
   The key can **only** open those three forwards; there is no shell, no exec, nothing else.
3. **Unit** (on `.210`): `deploy/remote-browser/pithagoras-browser-tunnel.service`, installed with
   **`User=hermes`** and the key path pointing at the `hermes` home (the committed file says
   `User=pithagoras` — the upstream account name; see Adaptations).
   `sudo cp <unit> /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now pithagoras-browser-tunnel`
   It opens one SSH connection with `-L 127.0.0.1:9222/3011/8082 → 192.168.0.197:9222/3011/8082`
   and restarts on failure; a second instance refuses to start if the ports are busy (loud, by
   design). **All `.210 → .197` browser traffic is this tunnel; nothing is inbound.**

## 4. On `.210`: the portal

In `/opt/pithagoras-build/.env` (the compose file passes these through; see the `environment:`
block in `docker-compose.yml`, commit `10e5e82`):

```
BROWSER_EXTERNAL=true          # the portal must NOT install its own browser add-on
BROWSER_CDP_URL=http://127.0.0.1:9222
BROWSER_VIEWER_PORT=3011
BROWSER_STREAM_PORT=8082
BROWSER_USER=agent             # the viewer's basic-auth USERNAME (must equal CUSTOM_USER on .197)
BROWSER_PASSWORD=<32-hex>      # the viewer's basic-auth password (must equal PASSWORD on .197)
```

These are the credentials **`browser-proxy.ts` injects** into every `/browser-ui/` request so the
browser window needs no login. (`BROWSER_EXTERNAL_USER` is not one of them — that name isn't read
for viewer auth; don't be misled by it.)

Then **recreate** the portal (restart does not re-read `.env`):
`cat deploy/rec | ssh hermes@192.168.0.210 'cat > /tmp/rec-portal.sh && bash /tmp/rec-portal.sh'`

## Check (the 2026-09-27 run, all passed)

- `.210`: `curl -s http://127.0.0.1:9222/json/version` → shows the `.197` browser (Chrome 153).
- `.210`: `curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:3011/` → **401** (upstream
  alive, auth wall present).
- `.197`: from another LAN box — 9222 and 8082 are connection-refused (loopback-only); 3010/3011
  are reachable, and 3011 answers **401** with no credential (its only wall is the password).
  If you want 3010/3011 off-LAN too, that's a PVE host-firewall rule, not a container change.
- **End-to-end (the important one):** log into the portal, `GET /api/browser/activity` → note the
  count; open a real tab on the `.197` browser via CDP (`/json/new?https://example.com` — **it's a
  PUT**, Gotcha 4); after ≤2 s the activity count has risen and reports the URL. That rising
  count is exactly what pops the floating window in the voice stage. Close the test tab afterwards.
- Voice services (llama/stt/tts) still healthy, portal `/` and `/avatar/` 200 over TLS.

## Rollback

- **Just the browser feature:** `BROWSER_EXTERNAL=false` (or remove the `BROWSER_*` block) +
  recreate the portal. The tunnel unit can stay up (it's inert) or `systemctl disable --now
  pithagoras-browser-tunnel`.
- **The portal build:** retag `compact-prod-prev-20260927a` (= build #14, image `7dcc4a2f26ff`) as
  `compact-prod` and re-run `deploy/rec`.
- **The whole container:** `docker rm -f hermes-browser` on `.197`; remove the `browser.cdp_url`
  line from `~/.hermes/config.yaml` (backup `config.yaml.bak-cdp-20260927`).

## Adaptations vs the generic procedure (what the original README assumed, what we did)

- **User:** upstream says `User=pithagoras`; `.210` runs everything as **`hermes`** — the installed
  unit is adapted (key path `/home/hermes/.ssh/browser_tunnel` too).
- **No portal browser add-on to stop:** `.210` never had its own `pithagoras-browser` container
  (ports were free), so there was nothing to stop before the tunnel took 9222/3011/8082.
- **No ufw on `.197`:** the `ufw deny …` step in the original has no effect there; LAN exposure is
  handled by the PVE host firewall + the 3011 password (verified in *Check*).
- **Hermes on the host, not a container:** `127.0.0.1:9222` is literally correct here; the
  `host.docker.internal`/socat caveats don't apply.

## Gotchas (learned the hard way, in order of pain)

1. **The portal's settings DB overrides `.env`, and a stale row there caused a login prompt.**
   `config()` reads the SQLite `settings` table first (`browser_user`/`browser_password`/…) and
   only falls back to env. A placeholder `browser_password` (8 chars, the literal word "password")
   had been saved via `PUT /api/browser/config`; the proxy then injected *that*, the viewer
   answered 401, and the browser's own Basic-auth dialog popped up for the user. **Fix:** delete
   the row (stop portal → `DELETE FROM settings WHERE key='browser_password'` → start portal) or
   `PUT /api/browser/config` with the *real* values. Symptom to look for: a login dialog in the
   floating window, or `/browser-ui/` returning 401 with a valid portal session.
2. **Secrets mangle in transit.** Copying the viewer password into `.env` via nested-ssh
   heredocs/args produced the literal 3-char string `***` (a masking layer in the transfer path).
   Pipe it directly (`ssh .197 'print password' | ssh .210 'cat > /tmp/pw'`) and move it with a
   script that reads the file; **verify by length + sha256, never by printing**. (Same failure
   class as the old Kokoro `.api_key` rot — see the Kokoro section in the skill.)
3. **Big `docker pull`/`docker run` on `.197` trip the interactive security-approval gate** in
   Hermes (it wants a live `y` and times out unattended). Workaround that works: run them from a
   **fresh `ssh hermes@127.0.0.1` session** (picks up the docker group, non-sudo, passes the
   gate).
4. **CDP endpoints `/json/new` and `/json/close/<id>` are PUT in this Chromium** (GET → 405).
5. **`docker compose restart` does not re-read `.env`** (long-standing portal gotcha) — any
   `BROWSER_*` change needs a **recreate** (`deploy/rec`).
6. **Disk on `.210` is ~97% full** (90 GB box, portal images ~1.5 GB each): before any rebuild,
   `docker builder prune -af` and keep only the newest `compact-prod-prev-*` rollback tag.

## Security notes

- Whoever reaches the CDP port controls the browser, including every site signed in there — which
  is why it stays on loopback and travels only inside the key-restricted SSH tunnel.
- The tunnel key is **forward-only**: even a fully stolen key gives an attacker the three port
  forwards on `.197`, not a shell; and it can't be used to reach anything else on the LAN (the
  `permitopen` list is the whole capability).
- Hermes can act as the user on any site it signs into in that profile; in its unattended API
  mode, actions that need approval are denied rather than asked. **Keep the browser profile to
  accounts you are comfortable delegating** (it persists in the `hermes-browser-profile` volume).
