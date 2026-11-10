# Agent Control as a container. The app has no npm dependencies, so the image is
# Node plus the source. The one optional package is a browser for bots
# (`browser.use`), off by default because it is large; build with
# `--build-arg INSTALL_BROWSER=1` (the compose file here does) to include it.
FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATA_FILE=/data/state.json
ARG INSTALL_BROWSER=0
ARG DEBIAN_FRONTEND=noninteractive
# A container has no user namespaces, so Chrome's own sandbox cannot start; the
# `1` from the same argument turns `--no-sandbox` on. The allowlist, egress
# proxy and fresh context per page in `agent/browser.mjs` still apply.
ENV BROWSER_NO_SANDBOX=${INSTALL_BROWSER}
RUN if [ "$INSTALL_BROWSER" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY shared ./shared
COPY agent ./agent
COPY scripts ./scripts
# The databases and the vault key live in /data. Mount a volume there, or the
# workspace is lost when the container is replaced.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Node 22 needs --experimental-sqlite for `node:sqlite`; the tag is pinned here so
# the container does not silently depend on a newer runtime.
CMD ["node", "--experimental-sqlite", "src/server.js"]
