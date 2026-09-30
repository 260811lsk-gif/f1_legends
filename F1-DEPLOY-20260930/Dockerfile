FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server/auth.cjs server/start.cjs server/rooms.cjs ./server/
COPY outputs/index.html ./outputs/index.html
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
USER node
EXPOSE 8080
CMD ["node", "server/start.cjs"]
