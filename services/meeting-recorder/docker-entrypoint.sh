#!/usr/bin/env bash
set -euo pipefail
# Start a virtual display and a virtual audio sink, then run the service.
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
# Run PulseAudio in the foreground-friendly daemon mode for this container.
pulseaudio --start --exit-idle-time=-1
# Null sink: Chromium plays meeting audio into it; ffmpeg records its .monitor.
pactl load-module module-null-sink sink_name="${AUDIO_SINK:-meet_sink}" sink_properties=device.description="${AUDIO_SINK:-meet_sink}"
pactl set-default-sink "${AUDIO_SINK:-meet_sink}"
mkdir -p "$(dirname "${DB_PATH:-./data/sessions.db}")" "${RECORDINGS_DIR:-./data/recordings}"
# On Cloudflare Containers there is no mounted secrets volume — download the
# bot's Google session from the worker at boot (gated on CONTROL_SECRET).
# Local docker runs keep using the -v mounted file and skip this.
STATE_PATH="${STORAGE_STATE_PATH:-/secrets/storageState.json}"
if [ -n "${STORAGE_STATE_URL:-}" ] && [ ! -f "$STATE_PATH" ]; then
  mkdir -p "$(dirname "$STATE_PATH")"
  curl -fsS -H "authorization: Bearer ${CONTROL_SECRET}" "$STORAGE_STATE_URL" -o "$STATE_PATH"
fi
exec npx tsx src/index.ts
