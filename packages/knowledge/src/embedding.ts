import { type EmbeddingModel, embedMany } from "ai";

/** Fixed so every embedding column is vector(768); providers are asked for 768 dims explicitly. */
export const EMBEDDING_DIMENSIONS = 768;

export type EmbeddingPurpose = "document" | "query";

export interface Embedder {
  /** The spec string stored in *_embedding_model columns, e.g. "google:gemini-embedding-001". */
  readonly model: string;
  /** One vector per value, each of length EMBEDDING_DIMENSIONS. `purpose` picks the task type where the
   *  provider supports it (Gemini RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY). */
  embed(values: string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

type ProviderOptions = NonNullable<Parameters<typeof embedMany>[0]["providerOptions"]>;

/** Structurally matches ResolvedEmbeddingModel from @ace/agent (which this package must not import). */
export interface ResolvedEmbedding {
  model: EmbeddingModel;
  providerOptions: (purpose: EmbeddingPurpose) => ProviderOptions;
}

const BATCH_SIZE = 50;
const MAX_PARALLEL_CALLS = 2;

export function createAiEmbedder(spec: string, resolved: ResolvedEmbedding): Embedder {
  return {
    model: spec,
    async embed(values, purpose) {
      const vectors: number[][] = [];
      for (let start = 0; start < values.length; start += BATCH_SIZE) {
        const { embeddings } = await embedMany({
          model: resolved.model,
          values: values.slice(start, start + BATCH_SIZE),
          maxParallelCalls: MAX_PARALLEL_CALLS,
          providerOptions: resolved.providerOptions(purpose),
        });
        for (const vector of embeddings) {
          if (vector.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(`embedding dimension ${vector.length} ≠ ${EMBEDDING_DIMENSIONS}`);
          }
          vectors.push(vector);
        }
      }
      return vectors;
    },
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Combining marks (\p{M}) stay inside tokens so Sinhala and Tamil words are not split mid-syllable.
const TOKEN = /\p{L}[\p{L}\p{M}\p{N}]*/gu;

function demoVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const tokens = text.normalize("NFKC").toLowerCase().match(TOKEN) ?? [];
  for (const token of tokens) {
    const word = fnv1a(token) % EMBEDDING_DIMENSIONS;
    vector[word] = (vector[word] ?? 0) + 1;
    const padded = Array.from(` ${token} `);
    for (let i = 0; i + 3 <= padded.length; i++) {
      const hash = fnv1a(`3:${padded.slice(i, i + 3).join("")}`);
      const bucket = hash % EMBEDDING_DIMENSIONS;
      vector[bucket] = (vector[bucket] ?? 0) + (hash >>> 31 === 1 ? -0.5 : 0.5);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

/** Keyless, deterministic and lexical: enough for tests and the CI relevance floor, never for production. */
export function createDemoEmbedder(): Embedder {
  return {
    model: "demo:hash-v1",
    async embed(values) {
      return values.map(demoVector);
    },
  };
}

export function embedderFor(
  spec: string,
  opts: { allowDemo: boolean; resolve: (spec: string) => ResolvedEmbedding },
): Embedder {
  if (spec.startsWith("demo:")) {
    if (!opts.allowDemo) throw new Error(`Embedding model "${spec}" is not allowed in production.`);
    return createDemoEmbedder();
  }
  return createAiEmbedder(spec, opts.resolve(spec));
}
