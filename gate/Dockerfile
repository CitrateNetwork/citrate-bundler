# citrate-bundler gate — auth + rate-limit + paymaster-precheck +
# metrics sidecar (EW-S1 WP-4 slice B). Sits between Caddy and the
# eth-infinitism bundler on the compose network.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3001
USER node
CMD ["node", "dist/server.js"]
