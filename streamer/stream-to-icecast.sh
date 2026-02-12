#!/usr/bin/env sh
set -eu

ALSA_DEVICE="${ALSA_DEVICE:-hw:Loopback,1,0}"
ICECAST_URL="${ICECAST_URL:-icecast://source:sourcepass@icecast:8000/stream}"
AUDIO_BITRATE="${AUDIO_BITRATE:-32k}"
AUDIO_SAMPLE_RATE="${AUDIO_SAMPLE_RATE:-22050}"
AUDIO_CHANNELS="${AUDIO_CHANNELS:-1}"

while true; do
  ffmpeg -hide_banner -loglevel warning -re \
    -f alsa -i "$ALSA_DEVICE" \
    -ac "$AUDIO_CHANNELS" \
    -ar "$AUDIO_SAMPLE_RATE" \
    -c:a libmp3lame -b:a "$AUDIO_BITRATE" \
    -content_type audio/mpeg \
    -f mp3 "$ICECAST_URL" || true

  sleep 2
done
