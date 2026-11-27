# Subtitle aligner used by the movie importer (familyhub-alass).
# Build on the server: docker build -t familyhub-alass scripts/docker/alass
# alass v2.0.0 (GPL-3.0, github.com/kaegi/alass), static Linux build from the official release.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY alass-linux64 /usr/local/bin/alass
RUN echo "7bd0b9ae7e035d3ba940eacffb21243614df36231d47f21f0b4ce42001ab7fcd  /usr/local/bin/alass" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/alass
USER 65534:65534
ENTRYPOINT ["/usr/bin/nice", "-n", "19", "/usr/local/bin/alass"]
