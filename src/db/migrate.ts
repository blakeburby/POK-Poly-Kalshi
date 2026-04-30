import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { logEvent } from "../logger";

export async function runMigrations(pool: Pool, migrationsDir = path.join(__dirname, "migrations")): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const existing = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [file]);
    if (existing.rows.length > 0) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      logEvent({ category: "DB", message: "migration applied", context: { version: file } });
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
