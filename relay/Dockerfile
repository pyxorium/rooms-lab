# The Rooms lab relay, built on Fly.io's remote builder (fly deploy). Modelled on Daisy's relay.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js rooms.js turn.js ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
