# g1tz teams: the account and organization service, plus the site.
# The server has no npm dependencies (bun:sqlite is built in), so nothing is
# installed: the sources run as they are.
FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV G1TZ_DB=/data/g1tz.sqlite
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun server ./server
COPY --chown=bun:bun site ./site
COPY --chown=bun:bun favicon.svg favicon.png logo.svg ./site/
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
CMD ["bun", "server/server.ts"]
