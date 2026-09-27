# The agent's browser on the Hermes host

Hermes (on .197) drives a Chromium on its own host; the portal (on .210) shows it live in the
voice stage's floating window and opens that window whenever the browser navigates.

```
.197  Chromium container (host network)          .210  portal
      ├─ 9222 debugging  ◄── Hermes (browser.cdp_url)    ├─ /browser-ui/ viewer  ─┐
      ├─ 3011 viewer (HTTPS)  ◄─┐                        ├─ status + navigations ─┤ 127.0.0.1:3011/9222/8082
      └─ 8082 stream          ◄─┴──── one SSH tunnel ◄───┴─ keep-alive viewer    ─┘ (pithagoras-browser-tunnel)
```

## 1. On .197: the browser

The same image and settings the portal uses for its own browser add-on
(`server/src/extensions/browser-service.ts`):

```sh
docker run -d --name hermes-browser --network host --restart unless-stopped \
  --security-opt seccomp=unconfined --shm-size=1g \
  -e PUID=0 -e PGID=0 -e TZ=Etc/UTC \
  -e CUSTOM_USER=agent -e PASSWORD='<viewer password>' \
  -e CUSTOM_PORT=3010 -e CUSTOM_HTTPS_PORT=3011 \
  -e CHROME_CLI=--remote-debugging-port=9222 -e RESTART_APP=true \
  -v hermes-browser-profile:/config \
  lscr.io/linuxserver/chromium:latest
```

Chrome keeps the debugging port on loopback. The viewer and stream ports (3010, 3011, 8082)
listen on all interfaces under host networking; since the portal reaches them through the tunnel,
block them from the LAN, e.g. `ufw deny 3010,3011,8082/tcp` (loopback is unaffected).

## 2. On .197: point Hermes at it

In `~/.hermes/config.yaml`:

```yaml
browser:
  cdp_url: http://127.0.0.1:9222
```

Use the plain `http://host:port` form, not a `ws://…/devtools/browser/<id>` address: that id
changes whenever the browser restarts.

`127.0.0.1` only works if the Hermes container uses host networking. Otherwise the container
cannot reach the host's loopback, and Chrome refuses debugging connections whose Host header is a
name rather than `localhost` or an IP; relay the port into Hermes's network (e.g. `socat`) and use
that IP.

A persona or memory note helps Hermes use it well: "Your browser is shown live to the user in the
Pithagoras voice window; they can watch it and type into it, e.g. to log in."

## 3. On .210: the tunnel

1. Stop or remove the portal's own browser add-on if it is installed (same ports).
2. Create a key for the tunnel: `ssh-keygen -t ed25519 -f /home/pithagoras/.ssh/browser_tunnel -N ''`.
3. On .197, create a `tunnel` user and add the public key to its `~/.ssh/authorized_keys`,
   restricted to these forwards:
   `restrict,port-forwarding,permitopen="127.0.0.1:9222",permitopen="127.0.0.1:8082",permitopen="127.0.0.1:3011" ssh-ed25519 AAAA…`
4. Install and start the unit:
   `sudo cp pithagoras-browser-tunnel.service /etc/systemd/system/ && sudo systemctl enable --now pithagoras-browser-tunnel`
   (adjust `User=` and the key path to the account that owns the key).

## 4. On .210: the portal

Portal environment: `BROWSER_EXTERNAL=true` (the portal must not install its own browser), and
the browser settings (user `agent`, the viewer password, HTTPS port 3011) matching step 1.
Restart the portal.

## Check

- `curl -s http://127.0.0.1:9222/json/version` on .210 shows the .197 browser.
- The voice stage shows the browser button; the window shows .197's Chromium.
- Ask Hermes to open a page: the window opens by itself within about two seconds
  (`GET /api/browser/activity` counts the navigations).

## Security

Whoever reaches the debugging port controls the browser, including every site signed in there;
that is why it stays on loopback and travels only inside SSH. Hermes can act as you on those sites,
and in its unattended API mode, actions that need approval are denied rather than asked. Keep the
browser profile to accounts you are comfortable delegating.
