# Railway builds and runs this Dockerfile directly (see railway.json's
# build.builder: "DOCKERFILE") in place of its default Nixpacks
# auto-detection — which means this file must build cleanly on its own, or
# nothing deploys at all. Verify it locally with `docker build .` before
# pushing a change here, the same way you'd run the test suite before
# pushing anything else.

# ---- deps: full dependency install, cached separately from source -------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript + generate the Prisma client -------------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

# ---- prod-deps: production-only install (smaller, no dev tooling) -------
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Non-root: without this, the process runs as root inside the container by
# default — an unnecessary privilege-escalation surface for a process that
# never needs root (no binding to a privileged port, no filesystem writes
# outside its own working directory).
RUN addgroup -S app && adduser -S app -G app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/generated ./generated
COPY package.json ./
# prisma/ (schema + migrations) ships in the runtime image, not just the
# build stage: Railway's pre-deploy command (`npx prisma migrate deploy` —
# see railway.json and README.md's "Deploying to Railway") runs inside a
# container built from this same image, before the new deployment starts
# receiving traffic. It needs the schema and migration files, and the
# `prisma` CLI package itself — which is why `prisma` lives in
# package.json's real `dependencies`, not `devDependencies`: an
# --omit=dev install must still include it.
COPY prisma ./prisma

USER app

EXPOSE 4000

CMD ["node", "dist/server.js"]
