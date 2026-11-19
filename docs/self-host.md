# Run your own news data server

This guide takes you from nothing to a news server that reads the RSS feeds you choose, stores
their articles in your own MongoDB database, and answers topic queries over a GraphQL API. It
works on a laptop and on a cloud machine: the steps are the same.

The server reads feeds that publishers publish. It does not crawl websites, does not summarise
articles, and keeps no reader accounts.

Every command below is meant to be copied as it is, into one terminal opened at the root of the
repository, unless a block starts with `# in a new terminal`.

## Fastest path on a laptop

If you only want to try it, take these choices and follow the steps in order:

- MongoDB: a free Atlas cluster (step 5).
- Redis: one Docker container (step 6).
- Embeddings: a local model with Ollama, so no key is needed (step 4).
- Translation: none, so articles stay in their own language (step 7).
- News API: open, without a key, listening on 127.0.0.1 only (step 11).

## 1. What runs

| Part | What it does | Port |
|---|---|---|
| Worker | Fetches your feeds, detects each article's language, translates it if you choose, creates embeddings, stores everything in MongoDB, and runs the hourly jobs. | 8080 |
| News API | Answers GraphQL queries: articles for a topic, headlines, related articles, search. | 3002 |
| MongoDB Atlas | Stores articles, feeds and topics, and holds the two search indexes. | |
| Redis | Holds the worker's job queues and a short-lived cache. | 6379 |
| Clustering job (optional) | Groups articles that report the same story. A separate project (step 14). | |

## 2. What you need

- Node.js 24 and npm.
- git.
- A MongoDB Atlas account. The free tier is enough to try it.
- Redis 7. Docker is the quickest way to run it on a laptop.
- Either a Jina API key, or any server that offers the OpenAI embeddings API, such as Ollama on your own machine.
- Optional: a Gemini API key, if you want articles translated to English.

## 3. Get the code

```sh
git clone https://github.com/Mera-News/mera-news-data-server.git
cd mera-news-data-server
npm ci
npm run build:async
npm run build:news-api
npm run build:scripts
```

## 4. Choose how articles are embedded

Every article and every topic you ask about is turned into a vector, and topics are matched to
articles by those vectors. You choose who makes the vectors. Read the trade-off first, because
changing your mind later means starting over (see [Change model or start over](#change-model-or-start-over)).

- **Jina, with your own key** (`EMBEDDING_PROVIDER=jina`). This is the model the server's scores
  are tuned on. Answers carry a relevance score, near copies of the same article from different
  publishers are grouped, and the score floor needs no tuning.
- **Any OpenAI-compatible embeddings server** (`EMBEDDING_PROVIDER=openai-compatible`), including
  a local model with Ollama. Nothing leaves your machine for embeddings. Answers carry no
  relevance score, near copies are not grouped, and you pick the score floor yourself (step 12).
  Jina reached through this setting counts as not tuned too.

For the local model, install Ollama from its website and pull the model:

```sh
ollama pull nomic-embed-text
```

`nomic-embed-text` makes 768-dimension vectors, which is what `EMBEDDING_DIMS=768` in step 8
says. Another model needs its own size there.

> Not proven yet: this route is checked against a stand-in that speaks the same API as Ollama,
> not against Ollama itself.

## 5. MongoDB Atlas

1. Create a cluster in MongoDB Atlas. The free tier works for a first try.
2. Under Database Access, create a database user with the `readWrite` role on the database you
   will use, for example `mera-news`.
3. Under Network Access, allow the address of the machine that runs the server.
4. Copy the connection string, and put your database name after the host:
   `mongodb+srv://USER:PASSWORD@cluster0.example.mongodb.net/mera-news`. A connection string
   without a database name does not work.

The worker creates the two search indexes it needs (a vector index and a text index on
`news-article`) the first time it starts. They take a few minutes to build. `/health/ready` and
the `newsServerStatus` query show their state.

> Not measured yet: whether a `readWrite` user may create search indexes on every Atlas tier,
> how many search indexes the free tier allows, and how long the first build takes. If the
> worker logs that it could not create an index, create both by hand
> ([Create the indexes by hand](#create-the-indexes-by-hand)) and set `SEARCH_INDEX_CREATE=false`.

If you manage your indexes yourself, set `SEARCH_INDEX_CREATE=false` and create them by hand.
The server never drops or changes an index.

## 6. Redis

Any Redis 7 works. It must not evict keys, because the job queues live there:

```sh
docker run -d --name news-redis -p 127.0.0.1:6379:6379 redis:7.2-alpine redis-server --maxmemory-policy noeviction
```

If you run Redis another way, set `maxmemory-policy noeviction` in its configuration.

## 7. Optional: translation

- `TRANSLATION_PROVIDER=none` keeps every article in its own language. Nothing is sent anywhere
  for translation.
- `TRANSLATION_PROVIDER=gemini` translates non-English titles and descriptions to English with
  Gemini. Set `GEMINI_API_KEY`.

## 8. Your settings

Put your settings in a file named `.env` at the root of the repository. Every part of the server
reads it. Start from this block, saved as `.env`:

```dotenv
# MongoDB Atlas: the connection string with your database name after the host.
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster0.example.mongodb.net/mera-news

# Redis
REDIS_URL=redis://127.0.0.1:6379

# The key that /invoke requires. Make one with: openssl rand -hex 32
MERA_SERVER_ASYNC_API_KEY=replace-with-a-long-random-value

# Embeddings: a local model through Ollama's OpenAI-compatible API.
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMS=768
# For Jina instead: EMBEDDING_PROVIDER=jina, JINA_API_KEY=your key, and remove
# EMBEDDING_BASE_URL and EMBEDDING_MODEL.

# Translation: none keeps articles in their own language.
TRANSLATION_PROVIDER=none
# For Gemini instead: TRANSLATION_PROVIDER=gemini and GEMINI_API_KEY=your key.

# News API: open, with no key, for your own machine only.
NEWS_API_OPEN=true
NEWS_API_HOST=127.0.0.1
# For a key instead: NEWS_API_OPEN=false and MERA_NEWS_API_KEY=a long random value.

# The worker runs the hourly jobs itself. Use this or your own cron table, never both.
LOCAL_SCHEDULES=true

# Lowest score a topic match may have. Pick yours in step 12.
VECTOR_MIN_SCORE=0.78

# Name your install and a way to reach you, so publishers know who fetches their feeds.
FEED_FETCH_USER_AGENT="my-news-server (contact: me@example.com)"

LOG_LEVEL=info
NODE_ENV=production
```

Do not set `PORT` in this file: both services read it, and they would then try to use the same
port. The worker listens on `ASYNC_PORT` (default 8080) and the news API on `NEWS_API_PORT`
(default 3002).

Every setting:

| Setting | Needed | Default | Read by | What it does |
|---|---|---|---|---|
| `MONGODB_URI` | yes | | all | Connection string, with the database name. |
| `REDIS_URL` | yes | | worker | Redis for the job queues and the cache. |
| `MERA_SERVER_ASYNC_API_KEY` | yes | | worker | The key `/invoke` requires. |
| `EMBEDDING_PROVIDER` | no | `jina` | all | `jina`, `openai-compatible` or `fake` (tests only). |
| `JINA_API_KEY` | with `jina` | | all | Your Jina key. |
| `EMBEDDING_BASE_URL` | with `openai-compatible` | | all | The server's base URL, ending before `/embeddings`. |
| `EMBEDDING_MODEL` | with `openai-compatible` | | all | The model name the server knows. |
| `EMBEDDING_API_KEY` | no | | all | Sent as a bearer token when set. |
| `EMBEDDING_DIMS` | no | `768` | all | The vector size your model makes. |
| `VECTOR_MIN_SCORE` | no | `0.78` | worker, news API | Lowest score a topic match may have, above 0 and at most 1. |
| `TRANSLATION_PROVIDER` | no | `gemini` | worker | `gemini`, `routed`, `none` or `fake` (tests only). |
| `GEMINI_API_KEY` | with `gemini` | | worker | Your Gemini key. |
| `NEWS_API_OPEN` | no | `false` | news API | `true` answers without a key. |
| `NEWS_API_HOST` | no | all addresses | news API | The address the news API listens on. |
| `NEWS_API_OPEN_RATE_LIMIT` | no | `60` | news API | Requests a minute per address in open mode. |
| `MERA_NEWS_API_KEY` | unless open | | news API | The key callers send as `x-api-key`. |
| `LOCAL_SCHEDULES` | no | `false` | worker | `true` runs the hourly jobs inside the worker. |
| `SEARCH_INDEX_CREATE` | no | `true` | worker | `false` never creates a search index. |
| `FEED_FETCH_ALLOW_HOSTS` | no | | worker, scripts | Private hosts the fetcher may reach (step 10). |
| `FEED_FETCH_USER_AGENT` | no | `mera-news-data-server (self-hosted)` | worker | The User-Agent of every feed fetch. |
| `PROXY_URLS` | no | | worker | Comma-separated proxies for feed fetches. |
| `ASYNC_PORT` | no | `8080` | worker | The worker's port. |
| `NEWS_API_PORT` | no | `3002` | news API | The news API's port. |
| `LOG_LEVEL` | no | `info` | all | `debug`, `info`, `warn` or `error`. |
| `NODE_ENV` | no | | all | `production` for a real run. |
| `SEARCH_CACHE_SECRET` | no | random | news API | Keys the search cache; set it so restarts keep the cache. |

## 9. Check your setup

```sh
npm run selfhost:check
```

It reads your settings, connects to MongoDB and Redis, looks at the search indexes and the
embedding model your database was built with, and prints one line for each thing that is wrong,
with what to do. It ends with `all good` when there is nothing to fix.

## 10. Add your sources

A feed file lists publishers by country (three-letter country code), each with one or more feeds:

```json
{
  "GBR": [
    {
      "publication_name": "Example Daily",
      "publication_website_uri": "https://example-daily.example.com",
      "publication_rss_feed_uris": [
        { "uri": "https://example-daily.example.com/rss.xml", "language_code": "en" }
      ]
    }
  ],
  "FRA": [
    {
      "publication_name": "Exemple Quotidien",
      "publication_website_uri": "https://exemple-quotidien.example.com",
      "publication_rss_feed_uris": [
        { "uri": "https://exemple-quotidien.example.com/feed", "language_code": "fr" }
      ]
    }
  ]
}
```

Save yours as `my-feeds.json` and load it:

```sh
npm run load-rss -- --file my-feeds.json
```

Running it again is safe: feeds are matched by address. To load only part of a file, add
`--only` once or more: a feed address, `country:GBR`, `language:en` (also matches `en-GB`), or
`all`. The repository also carries a large list of public feeds, which `npm run load-rss` loads
with no `--file`.

The fetcher refuses any feed address that is private or local: loopback, your local network,
link-local and cloud metadata addresses, and names that resolve to them. If one of your own
feeds lives on your local network, list its host and port in `FEED_FETCH_ALLOW_HOSTS`, for
example `FEED_FETCH_ALLOW_HOSTS=nas.lan:8080,192.168.1.20`. Each entry is a host, or a host and
port, matched exactly; without a port it allows ports 80 and 443 only; an IPv6 address goes in
brackets, as in `[fd00::5]:8080`. A listed feed is always fetched directly, never through
`PROXY_URLS`. There is no port restriction for public addresses.

A proxy in `PROXY_URLS` that sits inside your own network is not covered by these name checks:
use proxies outside it. If your machine may only reach the internet through a proxy, set it in
`PROXY_URLS`; the fetcher ignores `HTTP_PROXY` and `HTTPS_PROXY`.

## 11. Start the services

The worker:

```sh
# in a new terminal
node dist/apps/mera-server-async/main.js
```

Wait until it is ready:

```sh
curl --retry 60 --retry-all-errors --retry-delay 2 -fsS http://127.0.0.1:8080/health/ready
```

The news API:

```sh
# in a new terminal
node dist/apps/mera-server-news-api/main.js
```

```sh
curl --retry 60 --retry-all-errors --retry-delay 2 -fsS http://127.0.0.1:3002/health/ready
```

A refused request still gets HTTP status 200, with the reason in the GraphQL error's
`extensions.code`: `UNAUTHENTICATED` for a missing or wrong key, and `TOO_MANY_REQUESTS` over the
open-mode limit, with `retryAfterSeconds` and a `Retry-After` header.

With `NEWS_API_OPEN=true` the news API answers anyone who can reach it, without a key. Keep it on
127.0.0.1, or put a proxy with its own limits in front of it: anyone who reaches it can spend
your embeddings quota. With a key instead, callers send it as the `x-api-key` header.

On a cloud machine the steps are the same. The worker needs CPU all the time, so choose an
instance that is not throttled when idle, and run both services under a process manager. A
systemd unit for the worker:

```ini
[Unit]
Description=News data server worker
After=network-online.target

[Service]
WorkingDirectory=/opt/mera-news-data-server
ExecStart=/usr/bin/node dist/apps/mera-server-async/main.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## 12. Fetch now, and pick your score floor

Load the settings into your terminal, then ask the worker to fetch every feed that is due:

```sh
set -a && . ./.env && set +a
curl -fsS -X POST http://127.0.0.1:8080/invoke -H "x-api-key: $MERA_SERVER_ASYNC_API_KEY" -H "content-type: application/json" -d '{"queue_name": "news-sync-fanout"}'
```

Wait until articles are embedded:

```sh
until npm run --silent status -- --check embedded; do sleep 10; done
```

Ask for a topic:

```sh
curl -fsS http://127.0.0.1:3002/graphql -H "content-type: application/json" -d '{"query": "{ articleIdsForPersona(query: { topics: [{ text: \"electric buses\" }], limitPerTopic: 5 }) { topicResults { topicText articleIds } } }"}'
```

With Jina you are done. With any other model, see how your model scores a topic that should
match and one that should not:

```sh
npm run topic-scores -- "electric buses" "qwxz plorb"
```

Set `VECTOR_MIN_SCORE` in `.env` between the two, then restart both services.

## 13. The hourly jobs

| Job | When | What it does |
|---|---|---|
| `news-sync-fanout` | every hour at :00 | Fetches every feed that is due, then translates and embeds what arrives. |
| clustering (step 14) | every hour at :10 | Groups articles into stories. |
| `link-all-topics-to-clusters` | every hour at :20 | Links topics to stories, then builds the headline editions. |
| `data-retention-sweep` | every hour at :00, with `{"skipOrphans": true}` | Deletes what has passed its time (see step 17). |
| `data-retention-sweep` | every day at 03:15 | The full sweep. |

Choose one way to run them, never both:

- `LOCAL_SCHEDULES=true` (in the settings above): the worker runs all of them except clustering.
- Your own scheduler, for example cron, calling `/invoke` with the job's name as `queue_name`,
  and `{"skipOrphans": true}` as `data` for the hourly sweep.

To stop schedules a worker left behind after you switch to cron, start the worker once with
`LOCAL_SCHEDULES=false`: it removes them. Clustering always needs its own scheduler line.

## 14. Optional: group articles into stories

The clustering job is a separate project, `mera-news-clustering`.

> Available once that repository is public.

```sh
git clone https://github.com/Mera-News/mera-news-clustering.git ../mera-news-clustering
cd ../mera-news-clustering
make setup
set -a && . ../mera-news-data-server/.env && set +a
make run-cpu
cd ../mera-news-data-server
curl -fsS -X POST http://127.0.0.1:8080/invoke -H "x-api-key: $MERA_SERVER_ASYNC_API_KEY" -H "content-type: application/json" -d '{"queue_name": "link-all-topics-to-clusters"}'
until npm run --silent status -- --check linked; do sleep 10; done
```

It needs Python 3.14 and no GPU. Run it every hour at :10, after the fetch.

## 15. Optional: place search and topic categories

Place search (`placeSearch`) reads place names you load yourself from GeoNames. Download
`cities15000.zip` and, for region names, `admin1CodesASCII.txt` from
https://download.geonames.org/export/dump/, unzip the first, and run:

```sh
npm run seed-places -- --file cities15000.txt --admin1-file admin1CodesASCII.txt
```

Place names from GeoNames (https://www.geonames.org), licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/).

The topic categories behind `canonicalTopics` and the topic filter of `worldHeadlines` are seeded
by a command that must be told which database it writes to, the one named in `MONGODB_URI`:

```sh
npm run seed-canonical-topics -- --allow-db mera-news
npm run seed-canonical-topics -- --allow-db mera-news --execute
```

Without `--execute` it only reports what it would write. Articles are linked to categories only
with the Jina model the thresholds are tuned on; with another model the categories are seeded and
a topic filter answers `NO_TOPIC_LINKS`. The categories are the content categories of the Google
Cloud Natural Language API (https://docs.cloud.google.com/natural-language/docs/categories),
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

## 16. Query

Articles for a topic, as ids:

```sh
curl -fsS http://127.0.0.1:3002/graphql -H "content-type: application/json" -d '{"query": "{ articleIdsForPersona(query: { topics: [{ text: \"electric buses\" }], limitPerTopic: 5 }) { topicResults { topicText articleIds } } }"}'
```

The articles for those ids (put real ids from the answer above in place of the example):

```sh
curl -fsS http://127.0.0.1:3002/graphql -H "content-type: application/json" -d '{"query": "{ articlesForTopicsByIds(articleIds: [\"000000000000000000000000\"]) { articles { _id title_en article_url publication_name pubDate } } }"}'
```

Headlines for a country, or `GLOBAL` for all:

```sh
curl -fsS http://127.0.0.1:3002/graphql -H "content-type: application/json" -d '{"query": "{ topHeadlinesForCountry(countryCode: \"GBR\", first: 5) { headlines { clusterSize article { title_en article_url } } } }"}'
```

Other queries: `relatedArticles` and `newsClusterForArticle` for an article's story,
`searchNews` for search (only with a key: open mode does not offer search), `worldHeadlines`,
`canonicalTopics` and `newsServerStatus`. The schema is in
`apps/mera-server-news-api/src/schema.gql`, and the API answers introspection.

## 17. What is stored, and what leaves your machine

Stored in your MongoDB database:
- Articles, for 48 hours.
- Story clusters, for 48 hours.
- Article fingerprints (an address seen before), for 90 days, so an article is not stored twice.
- Topics you asked about, as anonymous shared rows, for 14 days after the last request. No reader
  accounts, and no request log with topics.

Leaves your machine:
- Feed fetches, to the publishers you listed.
- Embedding calls, to the embeddings provider you chose (none, with a local model).
- Translation calls, to the translation provider you chose (none, with `none`).
- Nothing else: there is no telemetry.

## 18. Keep it running

- `/health/ready` shows MongoDB, Redis and both search indexes. An index state never takes the
  service down, so do not point a startup probe at it.
- `npm run status` shows how far the pipeline has got.
- To update: `git pull`, `npm ci`, the three builds, then restart both services. If the vector
  index then reads `outdated`, the new release needs a field the old index lacks: drop it and
  let the worker create it again ([Index outdated](#index-outdated)).
- To stop: stop both services; your data stays in MongoDB.

## 19. Sizing

Measured numbers are not available for a single install yet. What grows: the article collection
holds 48 hours of what your feeds publish, with two vectors per article; the bundled public feed
list is very large, so start with your own file. Watch the database's storage, and the worker's
memory while a fetch runs.

## 20. Troubleshooting

Each search index state below shows in `/health/ready` and `newsServerStatus`, with the same
words as here. Topic queries answer `INDEX_NOT_READY`, naming the state, while the vector index
cannot serve; search answers from whichever half still works.

### Index missing

The index does not exist. With `SEARCH_INDEX_CREATE` unset or `true`, restart the worker and it
creates it. With `SEARCH_INDEX_CREATE=false`, create it by hand.

### Text index missing

Search then answers from meaning only, and finds fewer exact names. Restart the worker to create
it, or create it by hand.

### Index building

Atlas is building it. Wait; topic queries answer once it is ready.

### Index failed

The build failed, or the index stopped taking new articles. Drop it in the Atlas UI and restart
the worker, or create it again by hand.

### Index outdated

The index lacks a field this release needs. Drop it and restart the worker, or create it again by
hand.

### Index dims mismatch

The vector index holds vectors of another size than `EMBEDDING_DIMS`. See the next section.

### Index unreadable

The server could not read the list of search indexes, often because the database user lacks the
permission. Everything runs as before; check the index in the Atlas UI.

### Change model or start over

The database remembers which embedding model and vector size its vectors were made with, and
every part refuses to start under another one: vectors from two models cannot be compared. Either
set the model and `EMBEDDING_DIMS` back, or start over with a new, empty database (a new database
name in `MONGODB_URI`), and load your feeds again.

### Refused source

A feed's address is private or local (step 10). If it is yours, add its host and port to
`FEED_FETCH_ALLOW_HOSTS` and restart the worker; a refused feed is tried again on its own later.

### Local schedules

Use either `LOCAL_SCHEDULES=true` or your own cron table, never both: both would run each job.
Clustering still needs its own scheduler line.

### Empty answers

- No articles yet: run step 12 and wait for `status --check embedded`.
- Score floor too high for your model: pick it with `topic-scores` (step 12).
- The vector index is not ready: see its state above.

### Create the indexes by hand

In `mongosh`, connected to your database, at 768 dimensions (use your `EMBEDDING_DIMS`):

```javascript
db['news-article'].createSearchIndex({
  name: 'embedding_article_data_retrieval_index',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding_article_data_retrieval', numDimensions: 768, similarity: 'cosine' },
      { type: 'filter', path: 'createdAt' },
    ],
  },
});
db['news-article'].createSearchIndex({
  name: 'news_article_text_index',
  type: 'search',
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        title_en_internal_only: { type: 'string', analyzer: 'lucene.english' },
        description_en_internal_only: { type: 'string', analyzer: 'lucene.english' },
        title: { type: 'string', analyzer: 'lucene.standard' },
        createdAt: { type: 'date' },
      },
    },
  },
});
db['news-article'].aggregate([{ $listSearchIndexes: {} }]);
```

These are the definitions the worker creates, from
`libs/mera-models/src/search-index/retrieval-index.ts`.
