FROM node:22-bookworm-slim

# python3/make/g++ are needed to compile better-sqlite3's native addon.
# git is needed because some Baileys dependencies are installed straight
# from GitHub rather than the npm registry. ca-certificates is needed so
# git/curl can actually verify github.com's TLS certificate — this slim
# base image ships with no CA bundle at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./

# Some Baileys dependencies (e.g. libsignal-node) are declared as
# git+ssh://git@github.com/... URLs. There's no SSH key in this image, so
# rewrite those to plain HTTPS, which works anonymously for public repos.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && npm install --omit=dev

COPY . .

# Persist WhatsApp login + the SQLite database/uploaded images across
# container restarts.
VOLUME ["/app/auth_state", "/app/data"]

# Dashboard (Express). Not published to the host directly — see
# docker-compose.yml, which binds it to 127.0.0.1 only; the host's own
# nginx reverse-proxies it for public HTTPS access.
EXPOSE 3000

CMD ["node", "src/index.js"]
