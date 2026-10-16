import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

// An idle client dropped by a Postgres restart must not exit the process.
pool.on("error", (error) => console.error(error));

export function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
