# MongoDB Atlas Vector Search Indexes

All indexes below require MongoDB Atlas with vector search support.

## Required Indexes

Run these in `mongosh` connected to your Atlas cluster.

`test/harness/atlas-search-fake.indexes.json` holds the retrieval index the
server reads. The in-memory vector-search fake validates queries against it and
the CI e2e job creates its indexes from it, so change the definition there and
here together.

```javascript
// Vector index: article retrieval embedding (asymmetric search)
// Used by: topic linking (ArticleSearchService), GraphQL searchArticlesVector query,
//          articleIdsForTopics (articles-for-topics.service.ts cold path)
// Embedding model: Jina v5 text nano (768 dimensions, cosine similarity)
// The createdAt filter field is required — articleIdsForTopics pushes the 24h recency
// window into $vectorSearch.filter so the ANN budget is spent only on in-window candidates.
//
// MIGRATION NOTE: if you have the old index without the createdAt filter, drop it and
// recreate with this definition:
//   db['news-article'].dropSearchIndex("embedding_article_data_retrieval_index")
db['news-article'].createSearchIndex(
{
  "name": "embedding_article_data_retrieval_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      {
        "type": "vector",
        "path": "embedding_article_data_retrieval",
        "numDimensions": 768,
        "similarity": "cosine"
      },
      {
        "type": "filter",
        "path": "createdAt"
      }
    ]
  }
}
);
```

```javascript
// Vector index: user topic embedding
// Used by: topic deduplication (MeraProtocolUserTopicsService)
db['user-topic'].createSearchIndex(
{
  "name": "user_topic_embedding_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      {
        "type": "vector",
        "path": "news_topic_embed",
        "numDimensions": 768,
        "similarity": "cosine"
      }
    ]
  }
}
);
```
## Lexical index (Atlas Search, `type: "search"` — NOT `vectorSearch`)

```javascript
// Lexical/BM25 index: the text half of `searchNews`'s hybrid rank.
// Used by: NewsSearchService.runLexicalLeg (news-search.service.ts).
//
// FIELD NAMES ARE DELIBERATE. `title_en` / `description_en` are the v3 names and
// are populated on ZERO prod documents (0 of 166,099 measured over 24h); the live
// pipeline writes `title_en_internal_only` / `description_en_internal_only` on
// ~100% of them. The `@deprecated` markers on NewsArticle are inverted relative
// to reality. An index built on `title_en` indexes nothing at all. Add the v3
// names here the day the pipeline actually starts writing them.
//
// `dynamic: false` on purpose: the collection is ~5.2 GB over ~325k live docs,
// and a dynamic mapping would index every field including the vectors' metadata.
//
// NOT mapped, on purpose:
//   - `description` (original language) — low value against an English query and
//     it roughly doubles the index.
//   - `url_security_state` — the exclusion is `$ne: 'insecure'` and an ABSENT
//     field must keep serving, which a positive index filter cannot express. It
//     rides as a post-`$search` `$match` instead.
//
// COST: this is a third standing mongot index, and each one keeps a change stream
// scanning all `news-article` writes 24/7 — the same subsystem behind the hourly
// Atlas CPU alerts. On a staging cluster, create it when you need it and drop it
// when you are done; `searchNews` degrades to semantic-only without it rather
// than erroring, so its absence looks like weaker recall, not an outage.
db['news-article'].createSearchIndex(
{
  "name": "news_article_text_index",
  "type": "search",
  "definition": {
    "mappings": {
      "dynamic": false,
      "fields": {
        "title_en_internal_only":       { "type": "string", "analyzer": "lucene.english" },
        "description_en_internal_only": { "type": "string", "analyzer": "lucene.english" },
        "title":                        { "type": "string", "analyzer": "lucene.standard" },
        "createdAt":                    { "type": "date" }
      }
    }
  }
}
);
```

Verify it is queryable before testing anything against it — a `search` index reports
`status: "READY"` only once the initial build over the whole collection has finished,
which on a 325k-document collection is minutes, not seconds:

```javascript
db['news-article'].aggregate([{ $listSearchIndexes: { name: 'news_article_text_index' } }]);
```
