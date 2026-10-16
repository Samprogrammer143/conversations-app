// The local index: one SQLite file in the app's data folder. The window reads
// only from here, which is what keeps opening and searching instant. Everything
// in it can be rebuilt from the transcripts, so a schema change just rebuilds.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 5;

export function openDb(file: string, { readOnly = false } = {}): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly });
  db.exec("PRAGMA busy_timeout = 4000");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
  }
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value?: string } | undefined;
  const current = Number(row?.value || 0);
  if (current === SCHEMA_VERSION) return;
  // The index is a cache: rebuild it rather than migrate it. App-local state
  // (what you have read, app-started chats) is carried over.
  const keepState = current > 0 ? safeAll(db, "SELECT conversation_id, seen_at, seen_last_at FROM local_state") : [];
  const keepApp = current > 0 ? safeAll(db, "SELECT conversation_id, cwd, created_at FROM app_sessions") : [];
  db.exec(`
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS conversations;
    DROP TABLE IF EXISTS items;
    DROP TABLE IF EXISTS fts;
    DROP TABLE IF EXISTS fts_rows;
    DROP TABLE IF EXISTS fts_title;
    DROP TABLE IF EXISTS fts_vocab;
    DROP TABLE IF EXISTS edits;
    DROP TABLE IF EXISTS local_state;
    DROP TABLE IF EXISTS app_sessions;
    DROP TABLE IF EXISTS machines;
    DROP TABLE IF EXISTS machine_activity;
  `);
  db.exec(`
    CREATE TABLE sources (
      path TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL
    );
    CREATE INDEX sources_conv ON sources(conversation_id);

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      sig TEXT NOT NULL,
      primary_path TEXT,
      local_path TEXT,
      repo_dir TEXT,
      folder_key TEXT,
      project_id TEXT NOT NULL,
      project_label TEXT NOT NULL,
      title TEXT NOT NULL,
      first_prompt TEXT,
      last_prompt TEXT,
      preview TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      last_at TEXT,
      prompts INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      last_pc TEXT,
      pcs TEXT NOT NULL DEFAULT '[]',
      cwd TEXT,
      git_branch TEXT,
      model TEXT,
      version TEXT,
      context_tokens INTEGER,
      peak_context_tokens INTEGER NOT NULL DEFAULT 0,
      local_mtime_ms INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX conversations_last ON conversations(last_at DESC);
    CREATE INDEX conversations_project ON conversations(project_id);

    CREATE TABLE items (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;

    CREATE VIRTUAL TABLE fts USING fts5(body, conversation_id UNINDEXED, seq UNINDEXED, role UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
    CREATE TABLE fts_rows (conversation_id TEXT NOT NULL, row INTEGER NOT NULL);
    CREATE INDEX fts_rows_conv ON fts_rows(conversation_id);
    CREATE VIRTUAL TABLE fts_title USING fts5(title, conversation_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '1 2 3');
    CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts, 'row');

    CREATE TABLE edits (
      conversation_id TEXT PRIMARY KEY,
      pinned INTEGER,
      title TEXT,
      archived INTEGER,
      deleted INTEGER,
      app INTEGER
    );

    CREATE TABLE local_state (
      conversation_id TEXT PRIMARY KEY,
      seen_at TEXT,
      seen_last_at TEXT
    );

    CREATE TABLE app_sessions (
      conversation_id TEXT PRIMARY KEY,
      cwd TEXT,
      created_at TEXT
    );

    CREATE TABLE machines (
      prefix TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE machine_activity (
      name TEXT PRIMARY KEY,
      last_push_at TEXT
    );
  `);
  const insState = db.prepare("INSERT OR REPLACE INTO local_state (conversation_id, seen_at, seen_last_at) VALUES (?, ?, ?)");
  for (const r of keepState as { conversation_id: string; seen_at: string; seen_last_at: string }[]) insState.run(r.conversation_id, r.seen_at, r.seen_last_at);
  const insApp = db.prepare("INSERT OR REPLACE INTO app_sessions (conversation_id, cwd, created_at) VALUES (?, ?, ?)");
  for (const r of keepApp as { conversation_id: string; cwd: string; created_at: string }[]) insApp.run(r.conversation_id, r.cwd, r.created_at);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
}

function safeAll(db: DatabaseSync, sql: string): unknown[] {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

/** Runs fn in one transaction (much faster for bulk writes). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
}
