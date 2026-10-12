import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client";
import { staffTokens } from "../schema";

/** What may be shown to a merchant: never the hash. */
export interface StaffTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface StaffToken extends StaffTokenSummary {
  tenantId: string;
}

const SUMMARY = {
  id: staffTokens.id,
  name: staffTokens.name,
  tokenPrefix: staffTokens.tokenPrefix,
  revokedAt: staffTokens.revokedAt,
  createdAt: staffTokens.createdAt,
};

/** `tokenHash` is the sha256 of the whole `st_<tenantId>.<secret>` token; the token itself is never stored. */
export async function createStaffToken(
  tx: Tx,
  tenantId: string,
  input: { name: string; tokenHash: string; tokenPrefix: string },
): Promise<StaffTokenSummary> {
  const [row] = await tx
    .insert(staffTokens)
    .values({ tenantId, name: input.name, tokenHash: input.tokenHash, tokenPrefix: input.tokenPrefix })
    .returning(SUMMARY);
  if (!row) throw new Error("staff token insert returned no row");
  return row;
}

/**
 * The active token with this hash, or null (unknown, revoked, or another tenant's: row-level security hides
 * it). Run it inside withTenant for the tenant named in the token.
 */
export async function findStaffToken(tx: Tx, tokenHash: string): Promise<StaffToken | null> {
  const [row] = await tx
    .select({ ...SUMMARY, tenantId: staffTokens.tenantId })
    .from(staffTokens)
    .where(and(eq(staffTokens.tokenHash, tokenHash), isNull(staffTokens.revokedAt)));
  return row ?? null;
}

/** True when this call revoked it; false when it was already revoked or is not this tenant's. */
export async function revokeStaffToken(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .update(staffTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffTokens.id, id), isNull(staffTokens.revokedAt)))
    .returning({ id: staffTokens.id });
  return rows.length > 0;
}

/** Active and revoked tokens, newest first. */
export async function listStaffTokens(tx: Tx): Promise<StaffTokenSummary[]> {
  return tx.select(SUMMARY).from(staffTokens).orderBy(desc(staffTokens.createdAt), desc(staffTokens.id));
}
