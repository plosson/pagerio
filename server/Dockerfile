FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/pagerio.db
EXPOSE 3000
CMD ["bun", "src/index.ts"]
