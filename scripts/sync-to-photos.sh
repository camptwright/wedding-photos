#!/bin/bash
# =============================================================================
# sync-to-photos.sh
# Watches for new wedding photos/videos and imports them into Apple Photos.
#
# Prerequisites:
#   1. brew install fswatch
#   2. Mount the upload directory from the Proxmox LXC (NFS/SMB)
#      OR use rsync to mirror files locally
#   3. Grant Terminal (or this script) Full Disk Access in
#      System Settings > Privacy & Security > Full Disk Access
#   4. Grant Terminal permission to control Photos in
#      System Settings > Privacy & Security > Automation
#
# Usage:
#   ./sync-to-photos.sh /path/to/mounted/uploads "Wedding Album Name"
# =============================================================================

set -euo pipefail

WATCH_DIR="${1:?Usage: $0 <upload-directory> [album-name]}"
ALBUM_NAME="${2:-Wedding Photos}"
LOG_FILE="$HOME/wedding-photo-sync.log"
IMPORTED_LOG="$HOME/.wedding-imported-files"

if [ ! -d "$WATCH_DIR" ]; then
  echo "ERROR: Directory '$WATCH_DIR' does not exist."
  echo "Make sure the NFS/SMB share is mounted first."
  exit 1
fi

touch "$IMPORTED_LOG"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

create_album_if_needed() {
  osascript <<EOF
    tell application "Photos"
      if not (exists album "$ALBUM_NAME") then
        make new album named "$ALBUM_NAME"
      end if
    end tell
EOF
  log "Album '$ALBUM_NAME' ready."
}

import_file() {
  local filepath="$1"
  local filename
  filename=$(basename "$filepath")

  # Skip if already imported
  if grep -qF "$filepath" "$IMPORTED_LOG" 2>/dev/null; then
    return 0
  fi

  # Skip non-media files
  local ext="${filename##*.}"
  ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')
  case "$ext" in
    jpg|jpeg|png|heic|heif|webp|mp4|mov|m4v|3gp) ;;
    *) return 0 ;;
  esac

  # Wait for file to finish writing (network latency)
  sleep 1
  local size1 size2
  size1=$(stat -f%z "$filepath" 2>/dev/null || echo "0")
  sleep 2
  size2=$(stat -f%z "$filepath" 2>/dev/null || echo "0")
  if [ "$size1" != "$size2" ]; then
    log "File still transferring: $filename (waiting...)"
    sleep 5
  fi

  log "Importing: $filename"

  osascript <<EOF
    set filePath to POSIX file "$filepath"
    tell application "Photos"
      set theAlbum to album "$ALBUM_NAME"
      import {filePath} into theAlbum skip check duplicates yes
    end tell
EOF

  if [ $? -eq 0 ]; then
    echo "$filepath" >> "$IMPORTED_LOG"
    log "✓ Imported: $filename"
  else
    log "✗ Failed to import: $filename"
  fi
}

initial_sync() {
  log "Running initial sync of existing files..."
  find "$WATCH_DIR" -type f \( \
    -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \
    -o -iname "*.heic" -o -iname "*.heif" -o -iname "*.webp" \
    -o -iname "*.mp4" -o -iname "*.mov" -o -iname "*.m4v" \
    -o -iname "*.3gp" \
  \) | while read -r file; do
    import_file "$file"
  done
  log "Initial sync complete."
}

watch_for_new() {
  log "Watching for new uploads in: $WATCH_DIR"
  log "Importing to album: $ALBUM_NAME"
  log "Press Ctrl+C to stop."

  fswatch -0 --event Created --event MovedTo --recursive "$WATCH_DIR" | while IFS= read -r -d '' filepath; do
    if [ -f "$filepath" ]; then
      import_file "$filepath"
    fi
  done
}

# --- Main ---
log "=============================="
log "Wedding Photo Sync Starting"
log "=============================="

create_album_if_needed
initial_sync
watch_for_new
