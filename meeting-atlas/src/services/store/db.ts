import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { schemaSql } from "./migrations";

const nodeRequire = createRequire(__filename);

export interface MeetingAtlasStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface MeetingAtlasDb {
  exec(sql: string): void;
  prepare(sql: string): MeetingAtlasStatement;
}

interface DatabaseSyncConstructor {
  new (filename: string): MeetingAtlasDb;
}

function loadDatabaseSync(): DatabaseSyncConstructor {
  const sqlite = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
  return sqlite.DatabaseSync;
}

export function createDatabase(dbPath: string): MeetingAtlasDb {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);
  return db;
}

export function createMemoryDatabase(): MeetingAtlasDb {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);
  return db;
}
