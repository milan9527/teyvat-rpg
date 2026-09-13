import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/super_agent',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwtSecret: process.env.JWT_SECRET || 'teyvat-dev-secret-change-me',
  jwtExpiry: '30d',
  schema: 'teyvat',
  // Serve the built client from server when it exists (production single-port mode).
  staticDir: process.env.STATIC_DIR || '../client/dist',
  tickRate: 20,
  maxPlayersPerZone: 8,
  isDev: process.env.NODE_ENV !== 'production',
};
