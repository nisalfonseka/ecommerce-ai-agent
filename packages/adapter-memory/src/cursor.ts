import { CommerceError } from "@ace/contracts";

export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`);
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw new CommerceError("INVALID_INPUT", "Invalid cursor");
  }
  const match = /^o:(\d+)$/.exec(decoded);
  const digits = match?.[1];
  if (digits === undefined) throw new CommerceError("INVALID_INPUT", "Invalid cursor");
  return Number(digits);
}
