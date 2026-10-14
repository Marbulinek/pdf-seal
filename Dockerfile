# syntax=docker/dockerfile:1

# --- Stage 1: build the server bundle and the Angular UI ---------------------
# Needs devDependencies (typescript, esbuild, the Angular CLI), so it's
# isolated to a stage that never ships -- only dist/ is copied out of it below:
# dist/server/server.js (the esbuild-bundled server) and
# dist/app/browser (the Angular build, which also carries app/public/
# assets and pdf.js's worker, copied from node_modules/pdfjs-dist).
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY angular.json ./
COPY server ./server
COPY app ./app
RUN npm run build

# --- Stage 2: production-only node_modules ----------------------------------
# A separate install (rather than `npm prune` on stage 1) keeps this fully
# cacheable independent of source changes, and guarantees no dev tooling
# (tsx, typescript, the Angular CLI, @types/*) ends up in the runtime image.
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
COPY --chown=node:node package.json ./

RUN mkdir -p uploads && chown node:node uploads
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/server.js"]
