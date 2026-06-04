# Wedding Photo Booth — Self-Hosted Setup Guide

A complete guide to deploying the wedding photo upload platform on your Proxmox home server, with Cloudflare Tunnel for free public HTTPS, automatic Apple Photos sync via your Mac Mini, and a live **photo wall** you can project at the reception.

---

## What You Get

- **Guest upload page** — guests scan a QR code, enter their name, and upload photos/videos (with a per-guest limit you control).
- **Live photo wall** — a full-screen slideshow for a projector/TV that updates within ~2 seconds of each upload.
- **Apple Photos sync** — every upload is auto-imported into a Photos album on your Mac Mini (and onward to iCloud Shared Albums).
- **Admin dashboard** — see who uploaded what, total counts, and storage used.

---

## Architecture Overview

```
   Guests' Phones              Cloudflare Tunnel (free)
        │                              │
   QR Code → https://photos.yourdomain.com
        │                              │
        └──────── HTTPS ───────────────┘
                    │
            ┌───────┴───────────┐
            │   Proxmox LXC     │
            │  Node.js + SQLite │
            │   Port 3000       │
            └───┬───────────┬───┘
                │ LAN        │ HTTPS (SSE live push)
        ┌───────┴──────┐  ┌──┴─────────────────┐
        │  Mac Mini    │  │  Projector / TV     │
        │ sync script →│  │  /wall (slideshow)  │
        │ Apple Photos │  │                     │
        └──────────────┘  └─────────────────────┘
```

---

## Part 1: Proxmox LXC Setup

### 1.1 Create the Container

In the Proxmox web UI (`https://your-proxmox-ip:8006`):

1. **Download a template** if needed: Storage → local → CT Templates → Templates → `ubuntu-24.04-standard`.
2. **Create CT:**
   - **General:** CT ID = `200`, Hostname = `wedding-photos`, set a root password
   - **Template:** `ubuntu-24.04-standard`
   - **Disk:** 32 GB root (photos are stored here)
   - **CPU:** 2 cores
   - **Memory:** 1024 MB RAM, 512 MB swap
   - **Network:** Static IP on your LAN (recommended, so the Mac always finds it — e.g. `192.168.1.200`)
3. **Start** the container and open the console (or SSH in).

### 1.2 Install Dependencies Inside the LXC

```bash
apt update && apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify
node -v   # v20.x
npm -v
```

> This project uses `sql.js` (pure-JS SQLite), so no native build tools are required.

### 1.3 Deploy the Application

```bash
mkdir -p /opt/wedding-photos
cd /opt/wedding-photos

# Copy project files here. From your Mac/PC, for example:
#   scp -r ./wedding-photos/* root@LXC_IP:/opt/wedding-photos/

npm install

cp .env.example .env
nano .env
```

**Edit `.env` to match your wedding:**

```env
PORT=3000
UPLOAD_DIR=/opt/wedding-photos/uploads
MAX_UPLOADS_PER_GUEST=50
MAX_FILE_SIZE_MB=100

COUPLE_NAMES=Sarah & James
WEDDING_DATE=June 14, 2026

ADMIN_PASSWORD=your-secure-admin-password

# Photo wall
WALL_TOKEN=your-secret-wall-key
WALL_SLIDE_SECONDS=7
```

**Test it:**

```bash
node server.js
# 🎊 Wedding Photo Booth running on http://0.0.0.0:3000
# 🖼  Photo wall: http://0.0.0.0:3000/wall?key=your-secret-wall-key
```

Open `http://<LXC-IP>:3000` from another device on your LAN to confirm. Ctrl+C to stop.

### 1.4 Create a systemd Service

So the app auto-starts on boot and restarts on crash:

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
systemctl enable wedding-photos
systemctl start wedding-photos
systemctl status wedding-photos
```

---

## Part 2: Cloudflare Tunnel (Free Public HTTPS)

Gives you a public `https://` URL with no port forwarding.

### 2.1 Cloudflare Account + Domain

You need a domain on Cloudflare's free plan. Buy one at Cloudflare Registrar (~$10/yr) or transfer an existing domain's DNS. For testing without a domain, use the quick-tunnel option in 2.6.

### 2.2 Install cloudflared in the LXC

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i cloudflared.deb
```

### 2.3 Authenticate and Create the Tunnel

```bash
cloudflared tunnel login          # opens a browser URL to authorize
cloudflared tunnel create wedding-photos
# Note the tunnel ID (a UUID) it prints
```

### 2.4 Configure the Tunnel

```bash
mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml << 'EOF'
tunnel: YOUR_TUNNEL_ID
credentials-file: /root/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: photos.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
EOF
```

> The tunnel passes Server-Sent Events through fine (the wall's live updates rely on this), since the app sends the `X-Accel-Buffering: no` header.

### 2.5 Create the DNS Record

```bash
cloudflared tunnel route dns wedding-photos photos.yourdomain.com
```

### 2.6 Run as a Service

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared

curl https://photos.yourdomain.com/api/config
```

**Quick tunnel (no domain needed, for testing):**

```bash
cloudflared tunnel --url http://localhost:3000
# prints a random https://xxxx.trycloudflare.com URL
```

---

## Part 3: Apple Photos Auto-Sync (Mac Mini)

Every guest upload is pulled to the Mac Mini and imported into a Photos album. The included script polls the server every 30 seconds.

### 3.1 Copy and Configure the Script

```bash
mkdir -p ~/wedding-photos/scripts
# copy scripts/sync-to-photos.sh here, then:
chmod +x ~/wedding-photos/scripts/sync-to-photos.sh
nano ~/wedding-photos/scripts/sync-to-photos.sh
```

Set the variables at the top:

```bash
SERVER_URL="http://192.168.1.200:3000"   # your LXC LAN IP (or Cloudflare URL if remote)
ADMIN_PASSWORD="your-secure-admin-password"
ALBUM_NAME="Our Wedding"
POLL_INTERVAL=30
```

### 3.2 Grant Automation Permission (first run)

```bash
~/wedding-photos/scripts/sync-to-photos.sh
```

macOS will prompt to let Terminal control Photos — click **Allow**. Then Ctrl+C.

### 3.3 Run as a Background Daemon

Edit `scripts/com.wedding.photosync.plist` (set `YOUR_USERNAME`, `YOUR_LXC_IP`, password, album), then:

```bash
cp ~/wedding-photos/scripts/com.wedding.photosync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wedding.photosync.plist
tail -f /tmp/wedding-sync.log
```

### 3.4 iCloud Shared Album Bonus

In Photos on the Mac Mini, right-click the "Our Wedding" album → Share → iCloud Shared Album, and add the couple/family. Every imported photo then appears on their devices automatically.

---

## Part 4: The Live Photo Wall

A full-screen, self-updating slideshow for a projector, TV browser, or tablet at the reception. New uploads appear within ~2 seconds (via Server-Sent Events), with automatic polling as a fallback on flaky WiFi.

### 4.1 The Wall URL

```
https://photos.yourdomain.com/wall?key=YOUR_WALL_TOKEN
```

The `key` must match `WALL_TOKEN` in your `.env`. This keeps the photos from being viewable by anyone who simply guesses your domain — only someone with the key can open the wall or load its images.

> On your LAN you can also use `http://<LXC-IP>:3000/wall?key=YOUR_WALL_TOKEN` — handy if the venue WiFi is local-only.

### 4.2 How It Behaves

- **Ken Burns slideshow** — each photo slowly zooms/pans and crossfades to the next.
- **Fresh-first** — a just-uploaded photo jumps to the front of the rotation and shows a "Just Shared ✨" badge with the guest's name.
- **Videos** — play muted and auto-advance when they finish (capped at 14s).
- **Robust** — images that can't render (e.g. raw HEIC) are skipped automatically; if the live connection drops, the green dot turns gray and polling keeps it current.
- **Couple names** sit top-left; a live counter of total memories sits top-right.

### 4.3 Display Setup

**On a smart TV / laptop driving a projector:**
1. Open a browser and go to the wall URL.
2. Click once on the page — this lets the browser go full-screen (browsers require a user gesture) and enables video autoplay.
3. Press `F11` (Windows/Linux) or `Ctrl+Cmd+F` (Mac) for full-screen if it didn't auto-enter.

**On an iPad propped at the welcome table:**
1. Open the wall URL in Safari.
2. Tap **Share → Add to Home Screen**, then launch from the icon for a chrome-free full-screen view.
3. In Settings → Display & Brightness → Auto-Lock, set to **Never** so it doesn't sleep.

### 4.4 Tuning

- **Slide duration:** change `WALL_SLIDE_SECONDS` in `.env` (default 7) and restart the service.
- **A dedicated wall device on the LAN** avoids depending on the internet for the display — point it at the LXC IP directly.

---

## Part 5: QR Code Generation

Your upload URL is `https://photos.yourdomain.com`. Add a table number with `?table=5`.

```bash
# install qrencode (brew install qrencode  /  apt install qrencode)
qrencode -o table5.png -s 12 "https://photos.yourdomain.com?table=5"
```

Or use a free web generator (goqr.me) or Canva for decorative framed codes. Print 4×6 or 5×7 cards:

```
┌─────────────────────────────┐
│     Share Your Moments      │
│      with Sarah & James     │
│         ┌─────────┐         │
│         │ QR CODE │         │
│         └─────────┘         │
│  Scan to share your photos  │
│   & videos from today ♡     │
└─────────────────────────────┘
```

Place one per table plus a few at the bar and entrance.

---

## Part 6: Day-Of Checklist

### Night Before
- [ ] `curl https://photos.yourdomain.com/api/config` returns your details
- [ ] Sync daemon running: `tail -f /tmp/wedding-sync.log`
- [ ] Photos album exists on the Mac Mini
- [ ] Test the full loop: scan QR → upload → photo appears in Photos AND on the wall
- [ ] Open `/wall?key=...` on the display device, confirm full-screen + a test photo shows
- [ ] Strong `ADMIN_PASSWORD` and `WALL_TOKEN` set; service restarted
- [ ] Mac Mini on power + ethernet; display device set to never sleep

### During the Wedding
- [ ] QR cards placed; wall projecting
- [ ] Peek at the dashboard: `https://photos.yourdomain.com/admin`

### After the Wedding
- [ ] Final counts in the dashboard
- [ ] Photos already in Apple Photos; share via iCloud if not already
- [ ] Back up the originals from the server:
  ```bash
  scp -r root@LXC_IP:/opt/wedding-photos/uploads/ ~/Desktop/WeddingBackup/
  ```

---

## Cost Breakdown

| Item | Cost |
|------|------|
| Proxmox LXC | Free (your hardware) |
| Cloudflare Tunnel | Free |
| Domain (optional) | $0–10/yr |
| Node.js + dependencies | Free / open source |
| Apple Photos sync + wall | Free |
| QR card printing | ~$5–10 |
| **Total** | **$0–20** |

---

## Troubleshooting

**Wall shows "Access Key Required"**
- The `key` in the URL doesn't match `WALL_TOKEN` in `.env`. Re-check and restart the service.

**Wall is blank / photos don't advance**
- Click the page once (enables autoplay/full-screen).
- Check the live dot: gray = SSE disconnected but polling should still load photos every 15s.
- HEIC photos won't render in browsers and are skipped — most iPhone uploads via Safari arrive as JPEG, so this is rare.

**New photos take a while to appear on the wall**
- Confirm SSE isn't blocked: open the wall URL and watch the live dot stay green.
- The 15s polling fallback guarantees they show even if SSE is blocked.

**"Server unreachable" in sync log**
- LXC running? `systemctl status wedding-photos`. Reachable? `ping LXC_IP` from the Mac.

**Photos not importing to Apple Photos**
- Photos.app must be open; grant Terminal Automation permission in System Settings → Privacy & Security → Automation.

**Cloudflare tunnel down**
- `systemctl restart cloudflared`. Guests on venue WiFi can fall back to the LAN IP.

---

## Project Structure

```
wedding-photos/
├── server.js                 # Express API + SQLite + SSE live push
├── package.json
├── .env.example
├── public/
│   ├── index.html            # Guest upload app
│   ├── wall.html             # Live photo wall display
│   ├── css/
│   │   ├── style.css         # Upload app styling
│   │   └── wall.css          # Photo wall styling
│   └── js/
│       ├── app.js            # Upload app logic
│       └── wall.js           # Slideshow engine (SSE + polling)
└── scripts/
    ├── sync-to-photos.sh     # Mac Mini → Apple Photos daemon
    └── com.wedding.photosync.plist
```

---

## License

MIT — do whatever you want with it. Congrats to the happy couple. 🎉
