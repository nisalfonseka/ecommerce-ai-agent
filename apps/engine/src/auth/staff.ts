import { createHash, randomBytes } from "node:crypto";
import {
  type Db,
  findStaffToken,
  type StaffToken,
  createStaffToken as storeStaffToken,
  type Tx,
  withTenant,
} from "@ace/db";

const STAFF_TOKEN = /^st_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/i;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a bearer token that is shown once; only its SHA-256 hash is stored. */
export async function issueStaffToken(
  tx: Tx,
  tenantId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const token = `st_${tenantId}.${randomBytes(32).toString("base64url")}`;
  const stored = await storeStaffToken(tx, tenantId, {
    name,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 20),
  });
  return { id: stored.id, token };
}

/** Unknown, malformed and revoked tokens all return null. */
export async function authenticateStaff(
  db: Db,
  authorization: string | undefined,
): Promise<StaffToken | null> {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  const match = STAFF_TOKEN.exec(token);
  const tenantId = match?.[1];
  if (!tenantId) return null;
  return withTenant(db, tenantId, (tx) => findStaffToken(tx, hashToken(token))).catch(() => null);
}
