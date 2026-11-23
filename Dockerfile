FROM oven/bun:1.3.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build
USER bun
CMD ["bun", "dist/main.js"]
