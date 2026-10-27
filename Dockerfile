FROM node:22.16.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    NOGITA_STATE_DIR=/var/lib/nogita

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /var/lib/nogita \
    && chown node:node /var/lib/nogita
COPY --chown=node:node src ./src

USER node
EXPOSE 8787
VOLUME ["/var/lib/nogita"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "--experimental-transform-types", "src/app/server.ts"]
