# ---- build the client (VITE_DISCORD_CLIENT_ID is public; it ends up in the JS bundle)
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DISCORD_CLIENT_ID
RUN test -n "$VITE_DISCORD_CLIENT_ID" || (echo "VITE_DISCORD_CLIENT_ID build arg is required" && exit 1)
RUN npm run build

# ---- runtime: prod deps + server source + built client, runs as non-root
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
