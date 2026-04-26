// node:sqlite is built into Node.js 22+ — no npm package, no compilation needed.
// Run with: node --experimental-sqlite dist/index.js
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { config } from './config';

// Export the type alias so modules can reference it
export type DB = DatabaseSync;

let db: DatabaseSync;

export function initDatabase(): DatabaseSync {
  const dbPath = path.resolve(config.databasePath);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);

  // node:sqlite uses exec() for PRAGMA instead of .pragma()
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  createTables();
  console.log('✅ Database initialized');
  return db;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}


function createTables() {
  db.exec(`
    -- ─── GUILD SETTINGS ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id       TEXT PRIMARY KEY,
      guild_name     TEXT NOT NULL DEFAULT '',
      log_channel    TEXT,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ─── TEMP VOICE ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS temp_voice_config (
      guild_id        TEXT PRIMARY KEY,
      hub_channel_id  TEXT NOT NULL,
      category_id     TEXT NOT NULL,
      default_limit   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS temp_voice_channels (
      channel_id   TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      guild_id     TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS temp_voice_user_settings (
      user_id      TEXT PRIMARY KEY,
      channel_name TEXT,
      channel_limit INTEGER NOT NULL DEFAULT 0
    );

    -- ─── TICKETS ──────────────────────────────────────────────────

    -- Ticket questions (from OpenTicket questions.json)
    CREATE TABLE IF NOT EXISTS ticket_questions (
      id          TEXT PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label       TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'short',  -- short | paragraph
      required    INTEGER NOT NULL DEFAULT 1,
      placeholder TEXT,
      min_length  INTEGER,
      max_length  INTEGER,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    -- Blacklist (from OpenTicket blacklist)
    CREATE TABLE IF NOT EXISTS ticket_blacklist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      reason     TEXT,
      added_by   TEXT NOT NULL,
      added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(guild_id, user_id)
    );

    -- Per-category autoclose/autodelete config (from OpenTicket options)
    CREATE TABLE IF NOT EXISTS ticket_category_config (
      category_id               TEXT PRIMARY KEY,
      guild_id                  TEXT NOT NULL,
      -- Readonly admins (can view but not manage)
      readonly_admin_roles      TEXT NOT NULL DEFAULT '[]',
      -- Autoclose
      autoclose_enabled         INTEGER NOT NULL DEFAULT 0,
      autoclose_hours           INTEGER NOT NULL DEFAULT 24,
      autoclose_on_leave        INTEGER NOT NULL DEFAULT 0,
      autoclose_disable_claimed INTEGER NOT NULL DEFAULT 1,
      -- Autodelete
      autodelete_enabled        INTEGER NOT NULL DEFAULT 0,
      autodelete_days           INTEGER NOT NULL DEFAULT 7,
      autodelete_on_leave       INTEGER NOT NULL DEFAULT 0,
      -- Cooldown
      cooldown_enabled          INTEGER NOT NULL DEFAULT 0,
      cooldown_minutes          INTEGER NOT NULL DEFAULT 10,
      -- Limits
      global_max                INTEGER NOT NULL DEFAULT 0,
      user_max                  INTEGER NOT NULL DEFAULT 3,
      -- Slow mode on ticket channels
      slowmode_enabled          INTEGER NOT NULL DEFAULT 0,
      slowmode_seconds          INTEGER NOT NULL DEFAULT 20
    );

    CREATE TABLE IF NOT EXISTS ticket_panels (
      id                  TEXT PRIMARY KEY,
      guild_id            TEXT NOT NULL,
      channel_id          TEXT NOT NULL,
      message_id          TEXT,
      title               TEXT NOT NULL DEFAULT 'Support',
      description         TEXT NOT NULL DEFAULT 'Select a ticket category below.',
      color               TEXT NOT NULL DEFAULT '#5865F2',
      panel_style         TEXT NOT NULL DEFAULT 'buttons',
      image_url           TEXT,
      allow_multiple_open INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS ticket_categories (
      id              TEXT PRIMARY KEY,
      panel_id        TEXT NOT NULL,
      guild_id        TEXT NOT NULL,
      label           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      emoji           TEXT NOT NULL DEFAULT '🎫',
      color           TEXT NOT NULL DEFAULT 'Primary',
      category_id     TEXT,
      closed_category TEXT,
      admin_roles     TEXT NOT NULL DEFAULT '[]',
      channel_prefix  TEXT NOT NULL DEFAULT 'ticket-',
      welcome_message TEXT,
      allow_group     INTEGER NOT NULL DEFAULT 0,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (panel_id) REFERENCES ticket_panels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ticket_form_questions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id TEXT NOT NULL,
      guild_id    TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      label       TEXT NOT NULL,
      style       TEXT NOT NULL DEFAULT 'short',
      placeholder TEXT,
      required    INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id              TEXT PRIMARY KEY,
      guild_id        TEXT NOT NULL,
      channel_id      TEXT NOT NULL UNIQUE,
      creator_id      TEXT NOT NULL,
      category_id     TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',
      claimed_by      TEXT,
      priority        TEXT NOT NULL DEFAULT 'none',  -- none | low | medium | high
      ticket_number   INTEGER NOT NULL DEFAULT 0,
      transcript      TEXT,
      question_answers TEXT NOT NULL DEFAULT '{}',   -- JSON of question answers
      last_activity   INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      closed_at       INTEGER,
      FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_participants (
      ticket_id  TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      added_by   TEXT NOT NULL,
      added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (ticket_id, user_id),
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );

    -- ─── AUTO MODERATION ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS automod_config (
      guild_id            TEXT PRIMARY KEY,
      enabled             INTEGER NOT NULL DEFAULT 1,
      log_channel         TEXT,

      -- Bad Words
      bad_words_enabled   INTEGER NOT NULL DEFAULT 0,
      bad_words_action    TEXT NOT NULL DEFAULT 'delete',
      bad_words_list      TEXT NOT NULL DEFAULT '[]',

      -- Spam
      spam_enabled        INTEGER NOT NULL DEFAULT 0,
      spam_threshold      INTEGER NOT NULL DEFAULT 5,
      spam_interval       INTEGER NOT NULL DEFAULT 5,
      spam_action         TEXT NOT NULL DEFAULT 'mute',
      spam_mute_duration  INTEGER NOT NULL DEFAULT 5,

      -- Links
      links_enabled       INTEGER NOT NULL DEFAULT 0,
      links_action        TEXT NOT NULL DEFAULT 'delete',
      links_whitelist     TEXT NOT NULL DEFAULT '[]',

      -- Invites
      invites_enabled     INTEGER NOT NULL DEFAULT 0,
      invites_action      TEXT NOT NULL DEFAULT 'delete',

      -- Caps
      caps_enabled        INTEGER NOT NULL DEFAULT 0,
      caps_threshold      INTEGER NOT NULL DEFAULT 70,
      caps_min_length     INTEGER NOT NULL DEFAULT 10,
      caps_action         TEXT NOT NULL DEFAULT 'delete',

      -- Mentions
      mentions_enabled    INTEGER NOT NULL DEFAULT 0,
      mentions_threshold  INTEGER NOT NULL DEFAULT 5,
      mentions_action     TEXT NOT NULL DEFAULT 'mute',

      -- Exemptions
      exempt_roles        TEXT NOT NULL DEFAULT '[]',
      exempt_channels     TEXT NOT NULL DEFAULT '[]'
    );

    -- Warn history
    CREATE TABLE IF NOT EXISTS automod_warnings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      moderator  TEXT NOT NULL DEFAULT 'AutoMod',
      reason     TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- ─── ANNOUNCEMENTS ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS announcements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      color       TEXT NOT NULL DEFAULT '#5865F2',
      image_url   TEXT,
      thumbnail   TEXT,
      footer      TEXT,
      author      TEXT NOT NULL,
      sent_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      mention     TEXT
    );

    -- ─── WELCOME MESSAGES ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS welcome_config (
      guild_id          TEXT PRIMARY KEY,
      enabled           INTEGER NOT NULL DEFAULT 1,
      channel_id        TEXT,
      -- Embed settings
      title             TEXT NOT NULL DEFAULT 'Welcome to {server}!',
      description       TEXT NOT NULL DEFAULT 'Hey {user}, welcome to **{server}**! You are member #{count}.',
      color             TEXT NOT NULL DEFAULT '#57F287',
      image_url         TEXT,
      thumbnail_type    TEXT NOT NULL DEFAULT 'avatar',
      footer_text       TEXT NOT NULL DEFAULT 'Enjoy your stay!',
      -- DM settings
      dm_enabled        INTEGER NOT NULL DEFAULT 0,
      dm_message        TEXT NOT NULL DEFAULT 'Welcome to {server}! Please read the rules.',
      -- Ping settings
      ping_user         INTEGER NOT NULL DEFAULT 1,
      ping_channel_id   TEXT
    );

    -- ─── AUTO ROLES ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS auto_roles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      role_id    TEXT NOT NULL,
      label      TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(guild_id, role_id)
    );

    -- ─── REACTION ROLE PANELS ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS reaction_role_panels (
      id          TEXT PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT,
      title       TEXT NOT NULL DEFAULT 'React for Roles',
      description TEXT NOT NULL DEFAULT 'React below to assign yourself roles!',
      color       TEXT NOT NULL DEFAULT '#5865F2',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reaction_role_items (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_id  TEXT NOT NULL,
      guild_id  TEXT NOT NULL,
      emoji     TEXT NOT NULL,
      role_id   TEXT NOT NULL,
      label     TEXT,
      FOREIGN KEY (panel_id) REFERENCES reaction_role_panels(id) ON DELETE CASCADE
    );

    -- ─── RULES PANELS ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rules_panels (
      id          TEXT PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL,
      message_id  TEXT,
      title       TEXT NOT NULL DEFAULT '📜 Server Rules',
      description TEXT,
      color       TEXT NOT NULL DEFAULT '#5865F2',
      footer      TEXT NOT NULL DEFAULT 'Breaking rules may result in a mute, kick, or ban.',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rules_items (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_id  TEXT NOT NULL,
      guild_id  TEXT NOT NULL,
      number    INTEGER NOT NULL,
      title     TEXT NOT NULL,
      body      TEXT NOT NULL,
      FOREIGN KEY (panel_id) REFERENCES rules_panels(id) ON DELETE CASCADE
    );

    -- ─── SERVER LOGS ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS server_log_config (
      guild_id              TEXT PRIMARY KEY,
      enabled               INTEGER NOT NULL DEFAULT 1,
      -- Per-event channels (NULL = use default_channel)
      default_channel       TEXT,
      member_join_channel   TEXT,
      member_leave_channel  TEXT,
      member_ban_channel    TEXT,
      message_delete_channel TEXT,
      message_edit_channel  TEXT,
      role_change_channel   TEXT,
      voice_channel_channel TEXT,
      channel_change_channel TEXT,
      -- Per-event toggles
      log_member_join       INTEGER NOT NULL DEFAULT 1,
      log_member_leave      INTEGER NOT NULL DEFAULT 1,
      log_member_ban        INTEGER NOT NULL DEFAULT 1,
      log_message_delete    INTEGER NOT NULL DEFAULT 1,
      log_message_edit      INTEGER NOT NULL DEFAULT 1,
      log_role_change       INTEGER NOT NULL DEFAULT 1,
      log_voice_channel     INTEGER NOT NULL DEFAULT 0,
      log_channel_change    INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── Migrations (add columns to existing DBs safely) ──────────────────────
  const migrations = [
    `ALTER TABLE ticket_panels ADD COLUMN image_url TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }
}
