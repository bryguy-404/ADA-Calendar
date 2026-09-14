import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([...nextVitals, ...nextTs, globalIgnores([".next/**", ".next-e2e/**", ".next-crm-integration/**", ".next-password-check/**", ".data/**", ".data-e2e/**", "node_modules/**", "supabase/functions/**", "next-env.d.ts", "coverage/**", "playwright-report/**", "test-results/**"])]);
