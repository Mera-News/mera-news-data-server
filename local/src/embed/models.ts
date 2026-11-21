export interface ModelSpec {
  id: string;
  hubId: string;
  /** A full Hugging Face commit hash, so the same bytes are fetched every time. */
  revision: string;
  dims: number;
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix: string;
  passagePrefix: string;
  licence: 'MIT' | 'Apache-2.0' | 'CC-BY-NC-4.0';
  /** True when the weights' licence allows non-commercial use only. */
  nonCommercial: boolean;
}

/** Every entry states its licence; a non-commercial one is flagged and announced on download. */
export const KNOWN_LICENCES: readonly string[] = ['MIT', 'Apache-2.0', 'CC-BY-NC-4.0'];
export const NON_COMMERCIAL_LICENCES: readonly string[] = ['CC-BY-NC-4.0'];

// The ONNX repos of e5-small and Qwen3 carry no licence tag; the licence is the base model's.
export const MODELS: Record<string, ModelSpec> = {
  // The retrieval model Mera's own servers use. Its weights are CC BY-NC 4.0: free for
  // non-commercial use only.
  'jina-v5-nano': {
    id: 'jina-v5-nano',
    hubId: 'jinaai/jina-embeddings-v5-text-nano-retrieval',
    revision: 'ac5d898c8d382b17167c33e5c8af644a3519b47d',
    dims: 768,
    pooling: 'last_token',
    queryPrefix: 'Query: ',
    passagePrefix: 'Document: ',
    licence: 'CC-BY-NC-4.0',
    nonCommercial: true,
  },
  'e5-small': {
    id: 'e5-small',
    hubId: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dims: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    licence: 'MIT',
    nonCommercial: false,
  },
  'bge-m3': {
    id: 'bge-m3',
    hubId: 'Xenova/bge-m3',
    revision: '4de13258303883538bd53b696b452bf8099f0858',
    dims: 1024,
    pooling: 'cls',
    queryPrefix: '',
    passagePrefix: '',
    licence: 'MIT',
    nonCommercial: false,
  },
  'qwen3-0.6b': {
    id: 'qwen3-0.6b',
    hubId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'c25a394dd583836952667c12f008335071b3f43d',
    dims: 1024,
    pooling: 'last_token',
    // The model card format is `Instruct: {task}\nQuery:{query}`; documents take no instruction.
    queryPrefix: 'Instruct: Given a news topic that a reader follows, retrieve news articles about that topic\nQuery:',
    passagePrefix: '',
    licence: 'Apache-2.0',
    nonCommercial: false,
  },
};

/** One constant so a measurement can change it in one place. */
export const DEFAULT_MODEL = 'jina-v5-nano';

/** The MIT model to switch to when non-commercial use is not enough. */
export const OPEN_ALTERNATIVE_MODEL = 'e5-small';

/** The one line every download of a non-commercial model prints. */
export function licenceNotice(id: string): string | null {
  const m = MODELS[id];
  if (!m?.nonCommercial) return null;
  return `${m.id} is free for non-commercial use only (${m.licence}). To use an MIT model instead: mera-news-local config set embedder.model ${OPEN_ALTERNATIVE_MODEL}`;
}
