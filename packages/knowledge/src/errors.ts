export type KnowledgeSourceErrorCode =
  | "blocked_address"
  | "bad_url"
  | "too_large"
  | "timeout"
  | "unsupported_type"
  /** DNS answered but the connection failed (refused, reset, TLS error). */
  | "unreachable"
  /** The PDF could not be parsed. */
  | "bad_pdf"
  /** Extraction produced no text (e.g. a scanned PDF or an empty page). */
  | "empty"
  | `http_${number}`;

/**
 * An expected extraction failure. The message is the code alone: it is returned to the admin caller and may be
 * logged, so it must never carry document content or the URL (which can hold secrets in its query string).
 */
export class KnowledgeSourceError extends Error {
  readonly code: KnowledgeSourceErrorCode;

  constructor(code: KnowledgeSourceErrorCode) {
    super(code);
    this.name = "KnowledgeSourceError";
    this.code = code;
  }
}
