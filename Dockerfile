# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (incl. dev) for the TypeScript build
COPY package*.json ./
RUN npm ci

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=5050
WORKDIR /app

# Production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app
COPY --from=build /app/dist ./dist

EXPOSE 5050

# Container healthcheck against the API health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5050)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER node
CMD ["node", "dist/server.js"]
