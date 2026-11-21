// The whole news store, one SQLite file. Ids are 24 hex characters, the
// shape every client of the full server already handles. Times are UTC ISO strings.
//
// Each entry upgrades the file by one version, tracked in PRAGMA user_version.
// Never edit a released entry: add the next one.
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE publishers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  country_code TEXT,
  website_url  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (name, country_code)
) STRICT;

CREATE TABLE feeds (
  id                   TEXT PRIMARY KEY,
  publisher_id         TEXT NOT NULL REFERENCES publishers (id),
  feed_url             TEXT NOT NULL UNIQUE,
  publication_name     TEXT NOT NULL,
  publication_url      TEXT,
  country_code         TEXT,
  feed_language_code   TEXT,
  is_active            INTEGER NOT NULL DEFAULT 1,
  http_etag            TEXT,
  http_last_modified   TEXT,
  last_fetch_at        TEXT,
  last_fetch_status    TEXT,
  last_fetch_error     TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) STRICT;
CREATE INDEX feeds_publisher ON feeds (publisher_id);

-- The vector is written in the same transaction as the row, so a row never lacks one.
-- embedding_next holds a reembed in progress; it is swapped in at the end.
CREATE TABLE articles (
  rowid          INTEGER PRIMARY KEY,
  id             TEXT NOT NULL UNIQUE,
  feed_id        TEXT NOT NULL REFERENCES feeds (id),
  article_url    TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT,
  image_url      TEXT,
  language_code  TEXT,
  pub_date       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  run_id         TEXT,
  story_key      TEXT NOT NULL,
  embedding      BLOB NOT NULL,
  embedding_next BLOB
) STRICT;
CREATE INDEX articles_pub_date ON articles (pub_date);
CREATE INDEX articles_feed ON articles (feed_id, pub_date);

-- An address seen once is never ingested again, even after a prune.
CREATE TABLE fingerprints (
  key        TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- Exact copy keys; an article carrying one a stored article carries joins its story.
CREATE TABLE copy_keys (
  key        TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  PRIMARY KEY (key, article_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE ingest_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  feeds_ok      INTEGER NOT NULL DEFAULT 0,
  feeds_failed  INTEGER NOT NULL DEFAULT 0,
  articles_new  INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Trigrams match inside words in every script (Chinese, Japanese and Thai have no spaces).
-- A query shorter than three characters needs a LIKE scan instead.
CREATE VIRTUAL TABLE articles_fts USING fts5 (
  title, description,
  content = 'articles', content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);
CREATE TRIGGER articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER articles_fts_delete AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
END;
CREATE TRIGGER articles_fts_update AFTER UPDATE OF title, description ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO articles_fts (rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
`,
  `
-- When each feed last answered, so a failing feed can say when it last worked.
ALTER TABLE feeds ADD COLUMN last_ok_at TEXT;
UPDATE feeds SET last_ok_at = last_fetch_at WHERE last_fetch_status IN ('ok', 'not_modified');
`,
];
