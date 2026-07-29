FROM node:22-bookworm-slim

# python3/make/g++ are needed to compile better-sqlite3's native addon.
# git is needed because some Baileys dependencies are installed straight
# from GitHub rather than the npm registry.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persist WhatsApp login + the SQLite database across container restarts.
VOLUME ["/app/auth_state", "/app/data"]

CMD ["node", "src/index.js"]
