# node:24-slim tracks the latest Node 24 LTS: TypeScript runs directly (type stripping) and
# node:sqlite is built in, so there is no build step and no native module to compile.
FROM node:24-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# The live keyword config is baked into the image; edit + `railway up` to change it.
COPY triggers.json ./triggers.json

EXPOSE 3000
# Runs as root so the Railway volume mounted at /data is writable (volumes mount root-owned).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
