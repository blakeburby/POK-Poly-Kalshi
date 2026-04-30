import { createPool } from "./db/pool";
import { runMigrations } from "./db/migrate";
import { logEvent } from "./logger";

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await runMigrations(pool);
    logEvent({ category: "DB", message: "migrations complete" });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  logEvent({ severity: "ERROR", category: "DB", message: "migration failed", context: { error: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 1;
});
