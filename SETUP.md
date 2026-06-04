# Wedding Photo Booth — Complete Setup Guide

**Free, self-hosted, no domain required.** Guests scan a QR code, upload photos & videos, and everything flows into an Apple Photos album plus a live slideshow wall — all running on your Proxmox home lab and exposed to the internet through a **Cloudflare Quick Tunnel** (zero cost, no port forwarding).

---

## What You Get

- **Guest upload page** — scan a QR code, enter a name, upload photos/videos with a per-guest limit you set.
- **Live photo wall** — full-screen slideshow for a projector/TV that updates within ~2 seconds of each upload.
- **Apple Photos sync** — every upload auto-imports into a Photos album on your Mac Mini (and onward to iCloud Shared Albums).
- **Admin dashboard** — see who uploaded what, totals, and storage used.
- **Stable QR codes** — a free GitHub Pages redirect keeps your printed codes working even if the tunnel URL changes.

---

## Architecture

```
   Guests' Phones
        │  scan QR
        ▼
  https://YOURNAME.github.io/wedding   ← stable URL on printed QR codes (free GitHub Pages)
        │  instant redirect
        ▼
  https://<random>.trycloudflare.com   ← free Cloudflare Quick Tunnel (can change; auto-updated)
        │  outbound-only, no port forwarding
        ▼
  ┌─────────────────────┐
  │   Proxmox LXC        │  Node.js + SQLite, port 3000
  │   • upload API       │
  │   • photo wall (SSE) │
  │   • cloudflared      │
  │   • URL auto-publish │──→ pushes new tunnel URL to GitHub Pages
  └──┬───────────────┬───┘
     │ LAN           │ HTTPS (live SSE push)
     ▼               ▼
  Mac Mini         Projector / TV
  (Apple Photos)   (/wall slideshow)
```

---

## Prerequisites

- A Proxmox host (any recent version) with room for a small LXC.
- A Mac Mini (or any Mac) on the same network, for the Apple Photos import.
- A free **GitHub account** (you likely already have one) for the stable redirect URL.
- 30–45 minutes.

No domain, no paid services, no router/port-forward changes.

---

## Part 1 — Proxmox LXC

### 1.1 Create the container

In the Proxmox web UI (`https://your-proxmox-ip:8006`):

1. **Template:** Storage → local → CT Templates → Templates → download `ubuntu-24.04-standard` (if not present).
2. **Create CT:**
   - **General:** CT ID `200`, Hostname `wedding-photos`, set a root password.
   - **Template:** `ubuntu-24.04-standard`.
   - **Disk:** 32 GB root (photos live here).
   - **CPU:** 2 cores.
   - **Memory:** 1024 MB RAM, 512 MB swap.
   - **Network:** a **static IP** on your LAN (e.g. `192.168.1.200`) so the Mac always finds it.
3. **Start** the container, open the console (or SSH in as root).

### 1.2 Install Node.js

```bash
apt update && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
node -v   # v20.x
```

> This project uses `sql.js` (pure-JS SQLite) — no compilers or native build tools needed.

---

## Part 2 — Deploy the App

### 2.1 Copy the files

```bash
mkdir -p /opt/wedding-photos
cd /opt/wedding-photos
# From your computer, for example:
#   scp -r ./wedding-photos/* root@192.168.1.200:/opt/wedding-photos/
npm install
```

### 2.2 Configure

```bash
cp .env.example .env
nano .env
```

```env
PORT=3000
UPLOAD_DIR=/opt/wedding-photos/uploads
MAX_UPLOADS_PER_GUEST=50
MAX_FILE_SIZE_MB=100

COUPLE_NAMES=Sarah & James
WEDDING_DATE=June 14, 2026

ADMIN_PASSWORD=pick-a-strong-admin-password

# Photo wall
WALL_TOKEN=pick-a-secret-wall-key
WALL_SLIDE_SECONDS=7
```

### 2.3 Test, then run as a service

```bash
node server.js
# 🎊 Wedding Photo Booth running on http://0.0.0.0:3000
# 🖼  Photo wall: http://0.0.0.0:3000/wall?key=...
```

Open `http://<LXC-IP>:3000` from another LAN device to confirm, then Ctrl+C and install the service:

```bash
cat > /etc/systemd/system/wedding-photos.service << 'EOF'
[Unit]
Description=Wedding Photo Booth
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wedding-photos
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/wedding-photos/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wedding-photos
systemctl status wedding-photos
curl -s http://localhost:3000/api/config   # should print your couple names
```

---

## Part 3 — Public Access (Cloudflare Quick Tunnel + Stable QR URL)

A Quick Tunnel needs **no Cloudflare account, no login, no domain, no port forwarding** — just outbound internet. The only quirk: the URL is random and changes on restart, so we put a **stable GitHub Pages redirect** in front of it for the printed QR codes.

### 3.1 Install cloudflared

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
ln -sf "$(which cloudflared)" /usr/local/bin/cloudflared
cloudflared --version
```
> ARM host? Swap `amd64` → `arm64` in the URL.

### 3.2 Prove it works (manual test)

First confirm the app answers locally, then start a tunnel:

```bash
curl -s http://localhost:3000/api/config        # must return JSON first
cloudflared tunnel --url http://localhost:3000   # ONE command — no login needed
```

You'll see a box with `https://<random>.trycloudflare.com`. Open it on your phone **over cellular** (not WiFi) to prove it's truly public. Ctrl+C to stop.

> **Do NOT run `cloudflared tunnel login` / `create` / `route dns`** — those are the named-tunnel flow and require a domain. That is the trap that blocks people. Quick Tunnels ignore all of it.

### 3.3 Run the tunnel as a service

```bash
cp /opt/wedding-photos/quick-tunnel/wedding-tunnel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wedding-tunnel
sleep 6
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /var/log/wedding-tunnel.log | tail -1
```

That last command prints your current public URL. The service auto-restarts on crash/reboot (with a new URL each time — which Part 3.5 handles automatically).

### 3.4 Stable URL via GitHub Pages

Create a GitHub repo named `wedding` (Public). Then on the LXC:

```bash
cd /opt
git clone https://github.com/YOURUSER/wedding.git wedding-redirect
cd wedding-redirect

URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /var/log/wedding-tunnel.log | tail -1)
sed "s|__TUNNEL_URL__|$URL|g" /opt/wedding-photos/quick-tunnel/redirect-index.html > index.html
git add index.html && git commit -m "Initial redirect" && git push
```

In the repo: **Settings → Pages → Source = main / root**. Your stable URL becomes:
`https://YOURUSER.github.io/wedding/`

Open it — it should bounce straight to the upload page. **This is the URL you print on QR codes.**

### 3.5 Make the redirect self-healing (auto-update)

So a venue reboot never breaks your QR codes, have the LXC re-publish the tunnel URL whenever it changes.

**a) SSH deploy key (free, scoped to one repo):**
```bash
ssh-keygen -t ed25519 -C "wedding-lxc" -f /root/.ssh/wedding_deploy -N ""
cat /root/.ssh/wedding_deploy.pub
```
Add that public key in GitHub → `wedding` repo → **Settings → Deploy keys → Add deploy key**, with **Allow write access** checked.

```bash
cat >> /root/.ssh/config << 'EOF'
Host github-wedding
  HostName github.com
  User git
  IdentityFile /root/.ssh/wedding_deploy
  IdentitiesOnly yes
EOF

cd /opt/wedding-redirect
git remote set-url origin git@github-wedding:YOURUSER/wedding.git
git config user.email "lxc@wedding.local"
git config user.name "Wedding LXC"
git push   # confirm it pushes with no password prompt
```

**b) Install the publisher timer:**
```bash
cp /opt/wedding-photos/quick-tunnel/wedding-redirect.service /etc/systemd/system/
cp /opt/wedding-photos/quick-tunnel/wedding-redirect.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wedding-redirect.timer
journalctl -u wedding-redirect.service -f   # watch it publish
```

Every 60 seconds `publish-url.sh` reads the current tunnel URL and, **only if it changed**, rewrites `index.html` and pushes. Your QR codes self-heal within a minute of any restart.

> If your repo isn't at `/opt/wedding-redirect`, edit the paths at the top of `quick-tunnel/publish-url.sh`.

---

## Part 4 — Apple Photos Sync (Mac Mini)

Every upload is pulled to the Mac and imported into a Photos album; the script polls every 30 seconds.

### 4.1 Configure

```bash
mkdir -p ~/wedding-photos/scripts
# copy scripts/sync-to-photos.sh here, then:
chmod +x ~/wedding-photos/scripts/sync-to-photos.sh
nano ~/wedding-photos/scripts/sync-to-photos.sh
```
Set the variables at the top:
```bash
SERVER_URL="http://192.168.1.200:3000"        # LXC LAN IP
ADMIN_PASSWORD="pick-a-strong-admin-password"  # matches .env
ALBUM_NAME="Our Wedding"
POLL_INTERVAL=30
```

### 4.2 First run + permission

```bash
~/wedding-photos/scripts/sync-to-photos.sh
```
macOS prompts to let Terminal control Photos — click **Allow**, then Ctrl+C.

### 4.3 Run as a background daemon

Edit `scripts/com.wedding.photosync.plist` (set `YOUR_USERNAME`, `YOUR_LXC_IP`, password, album), then:
```bash
cp ~/wedding-photos/scripts/com.wedding.photosync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wedding.photosync.plist
tail -f /tmp/wedding-sync.log
```

### 4.4 iCloud Shared Album (optional)

In Photos: right-click the "Our Wedding" album → Share → iCloud Shared Album, add the couple/family. Imported photos then appear on their devices automatically.

---

## Part 5 — Live Photo Wall

A full-screen slideshow for a projector, TV browser, or tablet. New uploads appear within ~2 seconds (Server-Sent Events), with 15-second polling as a fallback.

**URL:** `https://YOURUSER.github.io/wedding/wall` won't work — the wall is served by the app, so use the **tunnel** for the display device, or the LAN IP:
```
http://192.168.1.200:3000/wall?key=YOUR_WALL_TOKEN          (LAN display — most reliable)
https://<current-tunnel>.trycloudflare.com/wall?key=...      (if the display is off-LAN)
```
The `key` must match `WALL_TOKEN` in `.env`, so random visitors can't pull the photos.

**Behavior:** Ken Burns zoom/pan with crossfades; just-uploaded photos jump to the front with a "Just Shared ✨" badge and the guest's name; videos play muted and auto-advance; unrenderable files (raw HEIC) are skipped; a green dot shows the live connection.

**Display tips:**
- On a TV/laptop: open the URL, **click once** (enables full-screen + video autoplay), press `F11` / `Ctrl+Cmd+F` for full screen.
- On an iPad: open in Safari → Share → Add to Home Screen → launch from the icon; set Auto-Lock to **Never**.
- Tune speed with `WALL_SLIDE_SECONDS` in `.env` (default 7), then `systemctl restart wedding-photos`.

> A display device wired to your LAN pointing at the LXC IP doesn't depend on the internet at all — the most bulletproof option for the wall.

---

## Part 6 — QR Codes

Point them at the **stable GitHub Pages URL**, never the tunnel URL:

```bash
# brew install qrencode   (Mac)   /   apt install qrencode   (Linux)
qrencode -o wedding-qr.png -s 12 "https://YOURUSER.github.io/wedding/"
qrencode -o table5.png    -s 12 "https://YOURUSER.github.io/wedding/?table=5"
```
The `?table=5` carries through the redirect into the upload page. Print 4×6 / 5×7 cards, one per table plus a few at the bar and entrance.

---

## Part 7 — Day-Of Checklist

**Night before**
- [ ] `systemctl status wedding-photos wedding-tunnel wedding-redirect.timer` — all green
- [ ] `https://YOURUSER.github.io/wedding/` redirects to the upload page from your phone **on cellular**
- [ ] Full loop test: scan QR → upload → appears in Apple Photos AND on the wall
- [ ] Restart test: `systemctl restart wedding-tunnel`, wait ~75s, reload the Pages URL — still reaches the app (proves auto-heal)
- [ ] Photos album exists on the Mac Mini; sync log healthy: `tail -f /tmp/wedding-sync.log`
- [ ] Strong `ADMIN_PASSWORD` + `WALL_TOKEN`; service restarted after any `.env` change
- [ ] Mac Mini on power + ethernet; display device set to never sleep; cellular hotspot on standby

**During**
- [ ] QR cards placed; wall projecting
- [ ] Peek at `…/admin` (via tunnel or LAN IP) for live counts

**After**
- [ ] Final counts in the dashboard; photos already in Apple Photos (share via iCloud if desired)
- [ ] Back up originals: `scp -r root@192.168.1.200:/opt/wedding-photos/uploads/ ~/Desktop/WeddingBackup/`

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tunnel hangs at "Requesting new quick Tunnel" | Outbound blocked — cloudflared needs **outbound** TCP 443 + UDP 7844. Check LXC/Proxmox/router egress. Test: `curl -sI https://www.cloudflare.com \| head -1` |
| QUIC / UDP errors in tunnel log | Force TCP: add `--protocol http2` to the `ExecStart` line in `wedding-tunnel.service` |
| URL appears but page is "connection refused" | App not answering on `localhost:3000` — `systemctl status wedding-photos` |
| Pages URL doesn't redirect | `publish-url.sh` hasn't pushed yet — `journalctl -u wedding-redirect.service`; confirm the deploy key push works |
| Works on cellular, not on venue WiFi | Guest WiFi may block unusual hosts — use a cellular hotspot; for the wall, use the LAN IP |
| Wall shows "Access Key Required" | `?key=` doesn't match `WALL_TOKEN`; restart the service after editing `.env` |
| HEIC photos missing from wall | Browsers can't render raw HEIC; most Safari uploads arrive as JPEG so it's rare — they're skipped, not lost (originals are on the server) |
| Photos not importing to Apple Photos | Photos.app must be open; grant Terminal **Automation** permission in System Settings → Privacy & Security |

---

## Project Structure

```
wedding-photos/
├── server.js                       # Express API + SQLite + live SSE push
├── package.json
├── .env.example
├── public/
│   ├── index.html                  # Guest upload app
│   ├── wall.html                   # Live photo wall
│   ├── css/ { style.css, wall.css }
│   └── js/  { app.js, wall.js }
├── scripts/
│   ├── sync-to-photos.sh           # Mac → Apple Photos daemon
│   └── com.wedding.photosync.plist
└── quick-tunnel/
    ├── wedding-tunnel.service       # runs the Quick Tunnel
    ├── redirect-index.html          # GitHub Pages redirect template
    ├── publish-url.sh               # pushes current tunnel URL to GitHub
    ├── wedding-redirect.service     # publisher (oneshot)
    └── wedding-redirect.timer       # runs publisher every 60s
```

---

## Cost

| Item | Cost |
|---|---|
| Proxmox LXC | Free (your hardware) |
| Cloudflare Quick Tunnel | Free |
| GitHub Pages redirect | Free |
| Apple Photos sync + wall | Free |
| Domain | $0 (none needed) |
| QR card printing | ~$5–10 |
| **Total** | **$0–10** |

---

## License

MIT — do whatever you want with it. Congrats to the happy couple. 🎉
