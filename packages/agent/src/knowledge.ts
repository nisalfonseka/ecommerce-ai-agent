export interface KnowledgePassage {
  documentTitle: string;
  heading: string | null;
  text: string;
  score: number;
}

/** Store-scoped knowledge supplied by the engine. The agent never imports the retrieval implementation. */
export interface KnowledgeSearch {
  /** Passages above the configured confidence threshold, best first. */
  search(query: string, options?: { limit?: number }): Promise<KnowledgePassage[]>;
}
