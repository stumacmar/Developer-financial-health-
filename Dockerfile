FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    PORT=8787 \
    RADAR_DB=/data/radar.sqlite \
    SYNC_INTERVAL_HOURS=24
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "--no-warnings", "src/cli.js", "serve"]
