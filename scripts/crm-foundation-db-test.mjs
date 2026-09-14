/** Only the named, isolated local ADA container. No credentials, providers or mail. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("./crm-foundation-db-test.sql", import.meta.url), "utf8");
// psql stops at the first error; disconnect rolls back even a failed test.
execFileSync("docker", ["exec", "-i", "supabase_db_ada-calendar", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
  input: sql, stdio: ["pipe", "inherit", "inherit"],
});
