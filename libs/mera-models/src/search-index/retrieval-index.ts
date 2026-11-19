/**
 * The search indexes the retrieval code queries, defined once. The server
 * creates them from these, the in-memory search fake validates queries
 * against them, and the end-to-end tests build them from them. It has no
 * imports, so any test can load it by relative path.
 */

export const NEWS_ARTICLE_COLLECTION = 'news-article';
export const VECTOR_INDEX_NAME = 'embedding_article_data_retrieval_index';
export const VECTOR_PATH = 'embedding_article_data_retrieval';
/** The lexical index `searchNews` queries. */
export const TEXT_INDEX_NAME = 'news_article_text_index';

export interface SearchIndexField {
  type: string;
  path: string;
  numDimensions?: number;
  similarity?: string;
}

export interface SearchIndexSpec {
  name: string;
  type: 'vectorSearch' | 'search';
  definition: Record<string, unknown>;
}

export interface VectorIndexSpec extends SearchIndexSpec {
  type: 'vectorSearch';
  definition: { fields: SearchIndexField[] };
}

/** `dims` is always `embeddingDims(config)`, the size the vectors are written at. */
export function retrievalIndexDefinition(dims: number): VectorIndexSpec {
  return {
    name: VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    definition: {
      fields: [
        {
          type: 'vector',
          path: VECTOR_PATH,
          numDimensions: dims,
          similarity: 'cosine',
        },
        // The 24 hour window rides inside the vector search, so the
        // candidate budget is spent on recent articles only.
        { type: 'filter', path: 'createdAt' },
      ],
    },
  };
}

/** The lexical half of `searchNews`. Mapped fields only: a dynamic mapping would index every field. */
export function textIndexDefinition(): SearchIndexSpec {
  return {
    name: TEXT_INDEX_NAME,
    type: 'search',
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          title_en_internal_only: {
            type: 'string',
            analyzer: 'lucene.english',
          },
          description_en_internal_only: {
            type: 'string',
            analyzer: 'lucene.english',
          },
          title: { type: 'string', analyzer: 'lucene.standard' },
          createdAt: { type: 'date' },
        },
      },
    },
  };
}
