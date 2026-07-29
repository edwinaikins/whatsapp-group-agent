FROM node:22-bookworm-slim

# better-sqlite3 needs build tools to compile its native addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persist WhatsApp login + the SQLite database across container restarts.
VOLUME ["/app/auth_state", "/app/data"]

CMD ["node", "src/index.js"]
