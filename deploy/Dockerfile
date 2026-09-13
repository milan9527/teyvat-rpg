# The game server (Fastify REST + WS gateway + the authoritative world simulation).
# Build context is the repo root, because `server/package.json` depends on the sim by path
# (`"@teyvat/shared": "file:../shared"`) — npm links it, and the link only resolves if the
# runtime image keeps the two directories in the same relative places as the install did.
#
#   docker build -f deploy/Dockerfile -t teyvat-server .
#
# The client is *not* in here: S3 + CloudFront serve the bundle, and the server's static
# handler is guarded by `fs.existsSync(dist/index.html)`, so its absence is a supported mode.

FROM node:22-alpine AS deps
WORKDIR /app
COPY shared/ ./shared/
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
# RDS refuses unencrypted connections (`rds.force_ssl` is on by default from Postgres 15), and
# its certificate chain is Amazon's own — not in the system trust store — so verifying the server
# needs this bundle on disk. The global bundle covers every region, so the image stays portable.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
COPY shared/ ./shared/
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && addgroup -S teyvat && adduser -S -G teyvat teyvat \
  && chown -R teyvat:teyvat /app
USER teyvat
WORKDIR /app/server
EXPOSE 8787
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "src/index.js"]
