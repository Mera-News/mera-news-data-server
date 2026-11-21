export interface ModelSpec {
  id: string;
  hubId: string;
  /** A full Hugging Face commit hash, so the same bytes are fetched every time. */
  revision: string;
  dims: number;
  pooling: 'mean' | 'cls' | 'last_token';
  queryPrefix: string;
  passagePrefix: string;
  licence: 'MIT' | 'Apache-2.0';
}

export const ALLOWED_LICENCES: readonly string[] = ['MIT', 'Apache-2.0'];

// The ONNX repos of e5-small and Qwen3 carry no licence tag; the licence is the base model's.
export const MODELS: Record<string, ModelSpec> = {
  'e5-small': {
    id: 'e5-small',
    hubId: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dims: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    licence: 'MIT',
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
  },
};

/** One constant so a measurement can change it in one place. */
export const DEFAULT_MODEL = 'e5-small';
