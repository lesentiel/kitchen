-- kitchen schema v1.
-- Statements are idempotent (IF NOT EXISTS) because the Worker applies this
-- file itself on first request; see src/migrate.ts.

CREATE TABLE IF NOT EXISTS kitchens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  kitchen_id    TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  invited_by    TEXT REFERENCES members(id),
  created_at    TEXT NOT NULL,
  token_rotated_at TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS members_kitchen ON members(kitchen_id);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  kitchen_id   TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL REFERENCES members(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  redeemed_at  TEXT,
  redeemed_by  TEXT -- member id; no FK: set in the same transaction that creates the member
);
CREATE INDEX IF NOT EXISTS invites_kitchen ON invites(kitchen_id);

CREATE TABLE IF NOT EXISTS recipes (
  id            TEXT PRIMARY KEY,
  kitchen_id    TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  servings      INTEGER,
  prep_minutes  INTEGER,
  cook_minutes  INTEGER,
  ingredients   TEXT NOT NULL DEFAULT '[]', -- JSON: [{name, quantity?, unit?, note?}]
  steps         TEXT NOT NULL DEFAULT '[]', -- JSON: [string]
  tags          TEXT NOT NULL DEFAULT '[]', -- JSON: [string], lowercased
  source        TEXT,
  notes         TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL REFERENCES members(id),
  updated_by    TEXT NOT NULL REFERENCES members(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipes_kitchen_updated ON recipes(kitchen_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS grocery_items (
  id          TEXT PRIMARY KEY,
  kitchen_id  TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  quantity    TEXT,
  unit        TEXT,
  note        TEXT,
  recipe_id   TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  checked     INTEGER NOT NULL DEFAULT 0,
  checked_by  TEXT REFERENCES members(id),
  checked_at  TEXT,
  added_by    TEXT NOT NULL REFERENCES members(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grocery_kitchen ON grocery_items(kitchen_id, checked, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  kitchen_id  TEXT NOT NULL REFERENCES kitchens(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('preference', 'dietary', 'conversation', 'plan', 'other')),
  subject     TEXT,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]', -- JSON: [string], lowercased
  author_id   TEXT NOT NULL REFERENCES members(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_kitchen_updated ON notes(kitchen_id, updated_at DESC);
