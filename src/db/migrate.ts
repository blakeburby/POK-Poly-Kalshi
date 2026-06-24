import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { logEvent } from "../logger";

export async function runMigrations(pool: Pool, migrationsDir = path.join(__dirname, "migrations")): Promise<void> {
  // Pin every statement to a single connection. `pool.query()` can route each call to a different pooled
  // connection, so BEGIN / the migration DDL / INSERT / COMMIT could land on separate physical connections and
  // the per-migration transaction would not actually be atomic. A dedicated client makes each migration all-or-nothing.
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [file],
      );
      if (existing.rows.length > 0) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logEvent({ category: "DB", message: "migration applied", context: { version: file } });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }
}
