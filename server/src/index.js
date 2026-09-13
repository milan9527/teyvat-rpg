import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import { config } from './config.js';
import { initSchema } from './db/init.js';
import { pool, pgAvailable } from './db/pg.js';
import { ensureRedis, redisIsFallback, closeRedis } from './db/redis.js';
import * as cache from './services/playerCache.js';
import { world } from './world/manager.js';
import { registerGateway } from './ws/gateway.js';

import authRoutes from './routes/auth.js';
import playerRoutes from './routes/player.js';
import gachaRoutes from './routes/gacha.js';
import worldRoutes from './routes/world.js';
import socialRoutes from './routes/social.js';
import shopRoutes from './routes/shop.js';
import mailRoutes from './routes/mail.js';
import achievementRoutes from './routes/achievements.js';
import expeditionRoutes from './routes/expedition.js';
import devRoutes from './routes/dev.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `postgres://user:secret@host/db` -> `postgres://user:***@host/db`, for anything logged. */
function redactUrl(url) {
  return String(url || '').replace(/(\/\/[^:/@]*:)[^@/]*@/, '$1***@');
}

const app = Fastify({
  logger: config.isDev
    ? { level: 'info', transport: undefined }
    : { level: 'warn' },
  bodyLimit: 1024 * 256,
  trustProxy: true,
});

async function main() {
  // --- infrastructure -------------------------------------------------------
  const dbOk = await pgAvailable();
  if (!dbOk) {
    // Never the whole URL: this line is the one thing that runs when a deployment is broken, so
    // it is exactly the line that ends up in a log aggregator. It printed the password into
    // CloudWatch on the first AWS deploy (RDS refused the unencrypted connection), which cost a
    // credential rotation. Keep the useful half — where we tried to reach, as whom.
    console.error(`[fatal] cannot reach Postgres at ${redactUrl(config.databaseUrl)}`);
    process.exit(1);
  }
  await initSchema();
  await ensureRedis();
  console.log(`[cache] redis ${redisIsFallback() ? 'unavailable — using in-process fallback' : 'connected'}`);

  // --- http -----------------------------------------------------------------
  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket, {
    options: { maxPayload: 1024 * 64, clientTracking: true },
  });

  await app.register(authRoutes);
  await app.register(playerRoutes);
  await app.register(gachaRoutes);
  await app.register(worldRoutes);
  await app.register(socialRoutes);
  await app.register(shopRoutes);
  await app.register(mailRoutes);
  await app.register(achievementRoutes);
  await app.register(expeditionRoutes);
  // Test hooks, and only outside production: `POST /api/dev/rank` is what lets the screenshot
  // probes reach the four rank-gated zones, and `POST /api/dev/supply` is what lets them afford
  // a party that can win a fight (it grants materials only — the probe still spends them through
  // the real growth routes). Announced at boot so they are never quietly on — see routes/dev.js
  // for why the gates cannot simply be relaxed for probes.
  if (config.isDev) {
    await app.register(devRoutes);
    console.log('[dev] test hooks enabled: POST /api/dev/rank, /api/dev/supply,'
      + ' /api/dev/expedition-rewind, /api/dev/resin-rewind (NODE_ENV !== production)');
  }

  app.get('/api/health', async () => ({
    ok: true,
    protocol: 3,
    redis: redisIsFallback() ? 'fallback' : 'redis',
    devHooks: config.isDev,
    uptime: Math.round(process.uptime()),
  }));

  app.get('/api/stats', async () => ({
    ...world.stats(),
    online: cache.onlineIds().length,
    memory: Math.round(process.memoryUsage().heapUsed / 1048576),
  }));

  registerGateway(app);

  // --- static client --------------------------------------------------------
  const dist = path.resolve(__dirname, '..', config.staticDir);
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');   // SPA fallback
    });
    console.log(`[static] serving ${dist}`);
  } else {
    console.log('[static] client not built — run "npm run build" for single-port mode');
  }

  cache.startAutosave(20000);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[server] listening on http://${config.host}:${config.port}  (ws://…/ws)`);
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} — draining…`);
  try {
    world.shutdown();
    await cache.flushAll();
    await app.close();
    await closeRedis();
    await pool.end();
  } catch (e) {
    console.error('[shutdown]', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => app.log.error({ err: e }, 'unhandledRejection'));

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
