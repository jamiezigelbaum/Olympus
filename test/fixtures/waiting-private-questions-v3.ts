// Frozen migration SQL from 7a1c09b7 (v3), independent of the current store.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runSqliteMigrations } from '../../src/core/sqlite-migrations.ts';

export function openV3Inbox(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  runSqliteMigrations(db, 'waiting-private-questions', [
    { version: 1, name: 'frozen_v3_1', up(db) { db.exec(`
        CREATE TABLE waiting_questions (
          id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL UNIQUE,
          connection_id TEXT NOT NULL,
          surface TEXT NOT NULL CHECK(surface IN ('chatgpt', 'remote')),
          question TEXT NOT NULL,
          detail TEXT NOT NULL CHECK(detail IN ('summary', 'full')),
          selectors TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('waiting', 'unchecked')),
          seen INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL,
          asked_at INTEGER NOT NULL
        );
        CREATE INDEX waiting_questions_connection ON waiting_questions (connection_id, asked_at);
        CREATE TABLE connection_revocations (
          connection_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL
        );
        CREATE TABLE waiting_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `); } },
    { version: 2, name: 'frozen_v3_2', up(db) { db.exec(`ALTER TABLE waiting_questions ADD COLUMN result TEXT;
        ALTER TABLE waiting_questions ADD COLUMN answered_at INTEGER;
        ALTER TABLE waiting_questions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE waiting_questions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;`); } },
    { version: 3, name: 'frozen_v3_3', up(db) { db.exec(`CREATE TABLE auto_answer_budgets (connection_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL)`); } },
  ]);
  return {
    ticket(connectionId: string) { return { connectionId }; },
    record(ticket: { connectionId: string }, input: { question: string; state: string; surface: string }) {
      const id = 'historical-row';
      db.query(`INSERT INTO waiting_questions
        (id, dedupe_key, connection_id, surface, question, detail, selectors, state, generation, asked_at)
        VALUES (?, ?, ?, ?, ?, 'summary', '{}', ?, 1, ?)`).run(id, id, ticket.connectionId, input.surface, input.question, input.state, Date.now());
      return { id, generation: 1, connectionId: ticket.connectionId };
    },
    saveAnswer(ref: { id: string }, result: unknown) {
      return db.query('UPDATE waiting_questions SET result = ?, answered_at = ? WHERE id = ?')
        .run(JSON.stringify(result), Date.now(), ref.id).changes === 1;
    },
    close() { db.close(); },
  };
}
