# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Instala dependências primeiro (camada cacheável)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copia fonte e compila
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies após build
RUN npm prune --production

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Segurança: não rodar como root
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 ricabot

WORKDIR /app

# Copia apenas o necessário
COPY --from=builder --chown=ricabot:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=ricabot:nodejs /app/dist ./dist
COPY --from=builder --chown=ricabot:nodejs /app/package.json ./package.json

# Copia prompts (arquivos .md do sistema)
COPY --chown=ricabot:nodejs prompts/ ./prompts/

USER ricabot

# Health check nativo — usa PORT do ambiente (injetado pelo orquestrador)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Porta definida pelo orquestrador (EasyPanel / Docker run -p)
# A app escuta em process.env.PORT (ver src/lib/env.ts)

CMD ["node", "dist/index.js"]
