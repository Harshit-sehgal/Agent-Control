# Agent Control as a container. There is nothing to install: the app has no
# npm dependencies, so the image is Node plus the source.
FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 DATA_FILE=/data/state.json
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
CMD ["node", "src/server.js"]
