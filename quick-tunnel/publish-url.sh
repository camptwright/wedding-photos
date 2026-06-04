#!/bin/bash
# Reads the current trycloudflare URL from the tunnel log and, if it changed,
# writes it into the GitHub Pages redirect repo and pushes.
set -euo pipefail

TUNNEL_LOG="/var/log/wedding-tunnel.log"
REPO_DIR="/opt/wedding-redirect"          # local clone of your github-pages repo
TEMPLATE="/opt/wedding-photos/quick-tunnel/redirect-index.html"
PAGE="$REPO_DIR/index.html"               # adjust if you put the redirect in a subfolder
STATE="/opt/wedding-redirect/.last_url"

# 1. Extract the most recent URL from the log
URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -1 || true)"
if [ -z "$URL" ]; then
  echo "$(date '+%H:%M:%S') no tunnel URL in log yet"
  exit 0
fi

# 2. Skip if unchanged
if [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$URL" ]; then
  exit 0
fi

echo "$(date '+%H:%M:%S') new tunnel URL: $URL — publishing"

# 3. Render the redirect page from the template
sed "s|__TUNNEL_URL__|$URL|g" "$TEMPLATE" > "$PAGE"

# 4. Commit + push
cd "$REPO_DIR"
git add index.html
git commit -m "Update wedding tunnel URL -> $URL" >/dev/null 2>&1 || true
git push >/dev/null 2>&1

echo "$URL" > "$STATE"
echo "$(date '+%H:%M:%S') published OK"
