# VAS Performance Tracker — production image
#
# Single-service image: Express API + built React frontend, exactly the layout
# backend/src/server.js expects in production (dist/ served by the API).
#
# Build:  docker build -t ghcr.io/abmak/vasperformancetracker:latest .
# Run:    docker compose up -d     (see docker-compose.yml; deployed to the VPS)
#
# NOTE: MySQL is NOT part of this image. It stays on the host as a system
# service (127.0.0.1:3306) together with the standby/failover setup — which is
# why the compose file uses host networking: the container reaches MySQL at
# 127.0.0.1 exactly like the pm2 process did.

# ---- stage 1: build the React frontend -------------------------------------
FROM node:18-alpine AS frontend-build
WORKDIR /fe
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- stage 2: install backend production dependencies -----------------------
FROM node:18-alpine AS backend-deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ---- stage 3: runtime -------------------------------------------------------
FROM node:18-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=backend-deps /app/node_modules ./backend/node_modules
COPY backend/package*.json ./backend/
COPY backend/src ./backend/src
COPY --from=frontend-build /fe/dist ./frontend/dist

# Run as the non-root user built into the node image
USER node

# backend/src/server.js resolves the SPA at ../../frontend/dist (see its
# "single-service mode" block) — the layout above matches that exactly.
WORKDIR /app/backend

EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:5001/api/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
