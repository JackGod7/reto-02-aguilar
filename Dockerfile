# Docker Official Image, indice multi-arquitectura consultado el 2026-11-04.
# Registro: https://registry-1.docker.io/v2/library/node/manifests/24-slim
FROM node:24.22.2-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src/ ./src/
COPY agent/ ./agent/
COPY web/ ./web/
COPY fixtures/ ./fixtures/
COPY demo.ts ./

RUN mkdir -p /app/out && chown node:node /app/out

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
