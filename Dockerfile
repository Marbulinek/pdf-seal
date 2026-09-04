# syntax=docker/dockerfile:1

# --- Stage 1: compile TypeScript -------------------------------------------
# Needs devDependencies (typescript, @types/*), so it's isolated to a stage
# that never ships -- only dist/ is copied out of it below.
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY esbuild.config.mjs ./
COPY server.ts ./
COPY lib ./lib
RUN npm run build

# --- Stage 2: production-only node_modules ----------------------------------
# A separate install (rather than `npm prune` on stage 1) keeps this fully
# cacheable independent of source changes, and guarantees no dev tooling
# (tsx, typescript, @types/*) ends up in the runtime image.
FROM node:24-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 3: runtime ---------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=320

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./

RUN mkdir -p uploads && chown node:node uploads
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
