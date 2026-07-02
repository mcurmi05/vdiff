# build stage: compile TypeScript
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# runtime stage: production deps only
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
# schema is idempotent (IF NOT EXISTS), safe to apply on every boot
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
