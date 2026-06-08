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
exec node dist/index.js
