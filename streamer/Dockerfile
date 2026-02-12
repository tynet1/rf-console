FROM debian:13-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY stream-to-icecast.sh /usr/local/bin/stream-to-icecast.sh
RUN chmod +x /usr/local/bin/stream-to-icecast.sh

ENTRYPOINT ["/usr/local/bin/stream-to-icecast.sh"]
