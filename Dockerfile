# The household server: one container serving the Forkcast frontend and the
# HTTP application interface from the shared Rust core. TLS is terminated by a
# reverse proxy in front of it (see deploy/Caddyfile).

FROM rust:1-bookworm AS web
RUN rustup target add wasm32-unknown-unknown \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# The desktop app and AI companion are not part of the server image.
RUN sed -i 's#, "crates/ai-companion", "crates/desktop"##' Cargo.toml \
 && cargo build --release -p forkcast-backend

FROM debian:bookworm-slim
RUN useradd --system --create-home --home-dir /data forkcast \
 && mkdir -p /app/web && chown forkcast /data
COPY --from=server /src/target/release/forkcast-backend /app/forkcast-backend
COPY --from=web /src/dist /app/web
USER forkcast
ENV FORKCAST_BIND=0.0.0.0:8787 \
    FORKCAST_DATABASE=/data/forkcast.sqlite3 \
    FORKCAST_STATIC_DIR=/app/web
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD ["/app/forkcast-backend", "--health"]
ENTRYPOINT ["/app/forkcast-backend"]
