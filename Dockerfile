FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:22-slim AS api
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=api /app/dist ./dist
COPY --from=web /app/web/dist ./web/dist
COPY docs/ ./docs/
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
