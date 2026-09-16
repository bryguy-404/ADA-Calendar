/** Only the named, isolated local ADA container. No credentials, providers or mail. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// psql stops at the first error; disconnect rolls back even a failed test.
for (const file of ["./crm-foundation-db-test.sql", "./crm-preview-db-test.sql", "./crm-transactions-db-test.sql", "./notification-preferences-db-test.sql"]) {
  const sql = readFileSync(new URL(file, import.meta.url), "utf8");
  execFileSync("docker", ["exec", "-i", "supabase_db_ada-calendar", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    input: sql, stdio: ["pipe", "inherit", "inherit"],
  });
}
