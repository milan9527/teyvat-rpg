-- Teyvat Online — schema
CREATE SCHEMA IF NOT EXISTS teyvat;
SET search_path TO teyvat, public;

CREATE TABLE IF NOT EXISTS accounts (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ,
  banned        BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS players (
  id              BIGSERIAL PRIMARY KEY,
  account_id      BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nickname        TEXT NOT NULL,
  adventure_rank  INT NOT NULL DEFAULT 1,
  adventure_xp    BIGINT NOT NULL DEFAULT 0,
  world_level     INT NOT NULL DEFAULT 0,
  mora            BIGINT NOT NULL DEFAULT 20000,
  primogem        BIGINT NOT NULL DEFAULT 1600,
  wish_ticket     INT NOT NULL DEFAULT 10,
  resin           INT NOT NULL DEFAULT 160,
  resin_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  zone            TEXT NOT NULL DEFAULT 'mondstadt',
  pos             JSONB NOT NULL DEFAULT '{"x":0,"y":4,"z":0,"ry":0}',
  party           JSONB NOT NULL DEFAULT '[]',
  active_slot     INT NOT NULL DEFAULT 0,
  wish_state      JSONB NOT NULL DEFAULT '{}',
  settings        JSONB NOT NULL DEFAULT '{}',
  stats           JSONB NOT NULL DEFAULT '{}',
  playtime_sec    BIGINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id)
);
CREATE INDEX IF NOT EXISTS players_rank_idx ON players (adventure_rank DESC, adventure_xp DESC);

CREATE TABLE IF NOT EXISTS player_characters (
  id           BIGSERIAL PRIMARY KEY,
  player_id    BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  char_id      TEXT NOT NULL,
  level        INT NOT NULL DEFAULT 1,
  xp           BIGINT NOT NULL DEFAULT 0,
  ascension    INT NOT NULL DEFAULT 0,
  talents      JSONB NOT NULL DEFAULT '{"normal":1,"skill":1,"burst":1}',
  dupes        INT NOT NULL DEFAULT 0,
  weapon_uid   TEXT,
  artifacts    JSONB NOT NULL DEFAULT '{}',
  hp           INT NOT NULL DEFAULT -1,   -- -1 = full
  energy       REAL NOT NULL DEFAULT 0,
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, char_id)
);
CREATE INDEX IF NOT EXISTS pchar_player_idx ON player_characters (player_id);

CREATE TABLE IF NOT EXISTS inventory (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  qty        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, item_id)
);

CREATE TABLE IF NOT EXISTS equipment (
  uid        TEXT PRIMARY KEY,
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,          -- weapon | artifact
  data       JSONB NOT NULL,
  equipped_by TEXT,                  -- char_id or NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS equip_player_idx ON equipment (player_id, kind);

CREATE TABLE IF NOT EXISTS quest_progress (
  player_id   BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quest_id    TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active',  -- active | done
  stage_index INT NOT NULL DEFAULT 0,
  counters    JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, quest_id)
);

CREATE TABLE IF NOT EXISTS world_progress (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  zone       TEXT NOT NULL,
  key        TEXT NOT NULL,     -- poi id / chest id / puzzle id / waypoint id
  value      JSONB NOT NULL DEFAULT '{}',
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, zone, key)
);

CREATE TABLE IF NOT EXISTS chamber_records (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  zone       TEXT NOT NULL,
  floor      INT NOT NULL,
  stars      INT NOT NULL DEFAULT 0,
  best_time  REAL,
  cleared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, zone, floor)
);

CREATE TABLE IF NOT EXISTS wish_history (
  id         BIGSERIAL PRIMARY KEY,
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  pool       TEXT NOT NULL,
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  rarity     INT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wish_player_idx ON wish_history (player_id, at DESC);

CREATE TABLE IF NOT EXISTS friends (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  friend_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, friend_id)
);

CREATE TABLE IF NOT EXISTS chat_log (
  id         BIGSERIAL PRIMARY KEY,
  player_id  BIGINT REFERENCES players(id) ON DELETE SET NULL,
  channel    TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  body       TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_at_idx ON chat_log (channel, at DESC);

CREATE TABLE IF NOT EXISTS leaderboard (
  player_id  BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  score      BIGINT NOT NULL DEFAULT 0,
  abyss_floor INT NOT NULL DEFAULT 0,
  abyss_stars INT NOT NULL DEFAULT 0,
  max_damage BIGINT NOT NULL DEFAULT 0,
  kills      BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lb_score_idx ON leaderboard (score DESC);

-- Shop stock. One row per (player, entry); `period` is the key of the period the count
-- belongs to (see shared/src/sim/clock.js), so a row from yesterday is not "stale data to
-- clean up" — it simply reads as zero bought. That is why there is no reset job and no
-- `resets_at` column: a stored deadline would be a second source of truth about the clock.
CREATE TABLE IF NOT EXISTS shop_purchases (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  entry_id   TEXT NOT NULL,
  bought     INT NOT NULL DEFAULT 0,
  period     TEXT NOT NULL DEFAULT '*',
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, entry_id)
);

-- Mail. Attachments live in `attach` as an item map (`{"mora":30000}`) — the same shape
-- `repo.addItems` takes — so claiming a letter is one call and needs no join table.
--
-- `dedupe` is what replaces a scheduler: it names *what* the letter is and *which period* it
-- belongs to (`login:2026-09-05`, `board:w2953`, `welcome`), and the partial unique index
-- below makes an insert idempotent. So "hand out today's sign-in gift" is an INSERT ... ON
-- CONFLICT DO NOTHING performed when the player opens the mailbox, not a cron job that has
-- to be running at 04:00. One-off letters (compensation) pass dedupe = NULL and are always
-- inserted, which is why the index has to be partial: NULLs would otherwise all collide in
-- a plain unique constraint on some engines, and here they must never collide at all.
--
-- Expiry is a read filter (`expires_at > now()`), not a sweep; nothing deletes rows on a
-- timer, for the same reason nothing resets shop stock on a timer.
--
-- Deleting is *soft* (`deleted`), and that is not tidiness — it is what keeps the dedupe key
-- meaningful. A hard DELETE removes the very row that proves today's gift was handed out, so
-- the next GET re-mints it: 删除已读 would have been an unlimited source of primogems, which
-- is exactly what `tools/api-check.mjs` caught. A soft-deleted row keeps the receipt and
-- leaves the mailbox. Hard deletion is only safe once a row has *expired*, because period
-- keys never repeat — `login:2026-09-05` can never be owed again.
CREATE TABLE IF NOT EXISTS mail (
  id         BIGSERIAL PRIMARY KEY,
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  dedupe     TEXT,
  sender     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  attach     JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed    BOOLEAN NOT NULL DEFAULT false,
  seen       BOOLEAN NOT NULL DEFAULT false,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
-- `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a column added
-- after the first deploy needs its own idempotent statement; this file is replayed whole on
-- every boot and has to stay safe to re-run.
ALTER TABLE mail ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS mail_dedupe_idx
  ON mail (player_id, dedupe) WHERE dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_box_idx ON mail (player_id, at DESC);

-- 探索派遣. One row per dispatch in flight, and the row *is* the pending reward: claiming is a
-- conditional `DELETE … RETURNING` and only what comes back gets paid, which makes a
-- double-clicked 领取 pay once without a second table to remember that it already did.
--
-- Deleting is safe here, unlike `mail` (see above), for one reason: the row proves nothing
-- about the past. What it holds is a *future* payout, and the only way to get another one is
-- to start another trip — whose `started_at` is written by `now()` on the server, never from
-- the client. So a purged row cannot re-arm a grant; it just frees the slot.
--
-- No `ends_at` column: `started_at + hours` is compared against the statement's own `now()`,
-- for the same reason `shop_purchases` stores a period key instead of `resets_at`. A stored
-- deadline is a second source of truth about the clock, and the two drift the moment a row is
-- edited (which is exactly what the dev rewind route does).
CREATE TABLE IF NOT EXISTS expeditions (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot       INT NOT NULL,
  char_id    TEXT NOT NULL,
  dest_id    TEXT NOT NULL,
  hours      INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, slot)
);
-- One trip per character, enforced by the database and not only by the route: the route reads
-- the rows, decides, and inserts, and two requests in the same tick would both pass that read.
CREATE UNIQUE INDEX IF NOT EXISTS exped_char_idx ON expeditions (player_id, char_id);

-- 成就. Deliberately the smallest table in the file: progress is *derived* on read from the
-- aggregates the other tables already keep (see shared/src/data/achievements.js), so the only
-- fact worth storing is how many tiers of each achievement have been paid out. `tier` is a
-- high-water mark, and the claim UPDATE guards on it, which is what makes a double-clicked
-- 领取 pay once.
CREATE TABLE IF NOT EXISTS achievements (
  player_id  BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ach_id     TEXT NOT NULL,
  tier       INT NOT NULL DEFAULT 0,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, ach_id)
);
