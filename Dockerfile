FROM oven/bun:1.4.4
WORKDIR /app
RUN chown bun:bun /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
