import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const credentialPattern = new RegExp("^ada_crm_v1_(" + uuid + ")\\.([A-Za-z0-9_-]{43})$");

export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Return the secret once to the owner/server setup path; persist only its hash. */
export function issueCrmCredential(connectionId: string): { token: string; hash: string } {
  if (!new RegExp("^" + uuid + "$").test(connectionId)) throw new Error("Invalid connection identifier.");
  const token = "ada_crm_v1_" + connectionId + "." + randomBytes(32).toString("base64url");
  return { token, hash: credentialHash(token) };
}

export function parseCrmCredential(authorization: string | null): { connectionId: string; token: string } | null {
  if (!authorization || authorization.length > 200 || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  const match = credentialPattern.exec(token);
  return match ? { connectionId: match[1], token } : null;
}

export function matchesCrmCredential(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(credentialHash(token), "hex");
  const validHash = /^[a-f0-9]{64}$/.test(expectedHash);
  const expected = validHash ? Buffer.from(expectedHash, "hex") : Buffer.alloc(32);
  return timingSafeEqual(actual, expected) && validHash;
}

export function isCrmPublicKey(value: string): boolean {
  if (value.length > 4096) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role === "anon";
  } catch { return false; }
}
