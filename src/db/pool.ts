import { Pool } from "pg";
import type { AppConfig } from "../config";
import { loadConfig } from "../config";

function sslForConnectionString(connectionString: string): false | { rejectUnauthorized: false } {
  return /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false };
}

export function createPool(config: AppConfig = loadConfig()): Pool {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: sslForConnectionString(config.databaseUrl),
    max: 8,
  });
}
