# Wedding Photo Booth 📷

Self-hosted, $0 wedding photo & video sharing for your Proxmox home lab.
Guests scan a QR code → upload → photos flow into Apple Photos + a live slideshow wall.
Public access via a free **Cloudflare Quick Tunnel** (no domain, no port forwarding).

## Quick start

1. Read **SETUP.md** — it walks through everything start to finish.
2. On the LXC: `npm install`, copy `.env.example` → `.env`, edit it, run `node server.js`.
3. Expose it: `cloudflared tunnel --url http://localhost:3000` (one command, no login).
4. Put a stable GitHub Pages redirect in front for the QR codes (SETUP.md Part 3).

## Pieces

- `server.js` — the whole backend (upload API, SQLite tracking, live photo-wall push).
- `public/` — guest upload app (`index.html`) + photo wall (`wall.html`).
- `scripts/` — Mac Mini → Apple Photos sync daemon.
- `quick-tunnel/` — Cloudflare Quick Tunnel service + self-healing GitHub Pages redirect.

Full instructions, troubleshooting, and the day-of checklist are in **SETUP.md**.

MIT licensed.
