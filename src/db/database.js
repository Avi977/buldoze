const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/dozer.db';

// Ensure data directory exists
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.resolve(DB_PATH));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    -- Registered devices (ESP32 units)
    CREATE TABLE IF NOT EXISTS devices (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      location     TEXT,
      secret_key   TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen    INTEGER,
      battery_pct  REAL,
      relay_state  INTEGER NOT NULL DEFAULT 0,  -- 0=OFF 1=ON
      is_online    INTEGER NOT NULL DEFAULT 0
    );

    -- Customers
    CREATE TABLE IF NOT EXISTS customers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      phone      TEXT,
      email      TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Payment & rental sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,
      device_id         TEXT NOT NULL REFERENCES devices(id),
      customer_id       TEXT REFERENCES customers(id),
      customer_name     TEXT,
      amount_paid       REAL NOT NULL,
      minutes_purchased INTEGER NOT NULL,
      seconds_remaining INTEGER NOT NULL,
      started_at        INTEGER,             -- unix timestamp when relay turned ON
      ended_at          INTEGER,             -- unix timestamp when relay turned OFF
      status            TEXT NOT NULL DEFAULT 'pending',
        -- pending | active | completed | stopped | low_battery
      square_payment_id TEXT UNIQUE,         -- Square payment ID, dedup key
      square_payload    TEXT,               -- raw Square JSON for audit
      created_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Battery & relay event log
    CREATE TABLE IF NOT EXISTS device_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL REFERENCES devices(id),
      session_id   TEXT REFERENCES sessions(id),
      event_type   TEXT NOT NULL,  -- heartbeat | relay_on | relay_off | low_battery | payment
      battery_pct  REAL,
      relay_state  INTEGER,
      note         TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_device   ON sessions(device_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status   ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_events_device     ON device_events(device_id);
    CREATE INDEX IF NOT EXISTS idx_events_created    ON device_events(created_at);

    -- Dozer reservations (future bookings)
    CREATE TABLE IF NOT EXISTS reservations (
      id            TEXT    PRIMARY KEY,
      device_id     TEXT    NOT NULL REFERENCES devices(id),
      customer_id   TEXT    REFERENCES customers(id),
      customer_name TEXT    NOT NULL DEFAULT 'Staff Hold',
      starts_at     INTEGER NOT NULL,
      ends_at       INTEGER NOT NULL,
      note          TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_reservations_device ON reservations(device_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_window ON reservations(starts_at, ends_at);
  `);
}

initSchema();

// ── Customer table migration ────────────────────────────────────────────────
// Adds extended fields if the DB was created before this version.
(function migrateCustomers() {
  const cols = db.prepare('PRAGMA table_info(customers)').all().map(c => c.name);
  const toAdd = [
    ['total_hours_played', 'REAL    NOT NULL DEFAULT 0'],
    ['hours_remaining',    'REAL    NOT NULL DEFAULT 0'],
    ['points',             'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [col, def] of toAdd) {
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE customers ADD COLUMN ${col} ${def}`);
      console.log(`[db] Migrated: customers.${col} added`);
    }
  }
}());

module.exports = db;
