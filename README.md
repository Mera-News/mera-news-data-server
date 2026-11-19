# mera-news-data-server

The news data server behind Mera News, by Mera Labs B.V. It reads RSS feeds that publishers publish. It detects the language, translates, creates embeddings and stores articles in MongoDB. It serves topic-to-article retrieval and headlines over a GraphQL API. It has no user accounts and stores nothing about readers. It shows headlines and links out to the publisher. It does not summarise articles, and it is not a crawler: it reads published RSS only.

## What you need

- Node 24
- A MongoDB deployment with vector search and search indexes
- Redis
- An embeddings key: `JINA_API_KEY` (used when `EMBEDDING_PROVIDER` is `jina`, the default)
- A translation key: `GEMINI_API_KEY` (used when `TRANSLATION_PROVIDER` is `gemini`, the default, with `GEMINI_TRANSPORT=developer`, also the default. `GEMINI_TRANSPORT=vertex` uses Google application default credentials instead)

Set `EMBEDDING_PROVIDER=fake` and `TRANSLATION_PROVIDER=fake` to run offline without keys. The fake providers are for local runs and tests.

The other variables are in [apps/mera-server-async/.env.example](apps/mera-server-async/.env.example). The main ones are `MONGODB_URI`, `REDIS_URL`, `MERA_SERVER_ASYNC_API_KEY` and `MERA_NEWS_API_KEY`.

Export the variables in your shell, or put them in a `.env` file. The ingest worker reads `apps/mera-server-async/.env`, `npm run load-rss` reads `apps/mera-scripts/.env`, and every service also reads a `.env` at the repository root. Run every command from the repository root.

## Set up MongoDB

1. Create a cluster in MongoDB Atlas.
2. Put its connection string in `MONGODB_URI`.
3. The worker creates the two search indexes on `news-article` the first time it starts, if they are missing. If you manage your indexes yourself, or your database user may not create search indexes, set `SEARCH_INDEX_CREATE=false` and create them by hand as [CREATE_VECTOR_INDEX.md](CREATE_VECTOR_INDEX.md) describes. The server never drops or changes an index.

Other MongoDB deployments that support the same indexes can work.

## Run it

```
npm install
npm run build:async
npm run build:news-api
npm run build:scripts
npm run load-rss
npm run async
npm run news-api
```

- `npm run load-rss` loads the feed list in `apps/mera-scripts/seed-data/active-feeds-auto-generated.json` into the database. It needs only `MONGODB_URI`. A full load upserts about 10,000 rows one at a time and takes about half an hour. `npm run load-rss -- --only <feedUrl>` loads one feed from that file (repeat `--only` for more). `--sync-delete` deletes every feed in the database that is not in the file, so run it without the flag first and read the count it would delete.
- `npm run async` starts the ingest worker. It listens on `PORT`, or `ASYNC_PORT` (default 8080).
- `npm run news-api` starts the GraphQL news API. It listens on `PORT`, or `NEWS_API_PORT` (default 3002).

The worker can run the hourly jobs itself with `LOCAL_SCHEDULES=true`; otherwise run them from your own scheduler. Use one or the other, never both. Ingest runs when something creates a job. The worker exposes `POST /invoke` for that. Send an `x-api-key` header that matches `MERA_SERVER_ASYNC_API_KEY`, and a JSON body with a `queue_name` and an optional `data` object:

```
curl -X POST http://localhost:8080/invoke \
  -H "x-api-key: $MERA_SERVER_ASYNC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"queue_name": "news-sync-fanout"}'
```

The `news-sync-fanout` queue creates a `load-rss-feed` job for each feed that is due, then translates and embeds what arrives. A `queue_name` that is not a known queue is refused with 400. Run the call from your own scheduler, such as cron, as often as you want new articles. Other valid queue names are listed in `libs/mera-shared/src/constants/queue-names.enum.ts`.

Grouping articles into stories is done by a separate clustering job that is not part of this repository.

## Who can call the news API

Every request needs an `x-api-key` header that matches `MERA_NEWS_API_KEY`, and the news API refuses to start without that variable unless open mode is on. `/health` needs no key.

`NEWS_API_OPEN=true` serves requests without a key. It is meant for one person's own install. Each address may then make `NEWS_API_OPEN_RATE_LIMIT` requests a minute (default 60).

A refused request still gets HTTP status 200, with the reason in the GraphQL error's `extensions.code`: `UNAUTHENTICATED` for a missing or wrong key, and `TOO_MANY_REQUESTS` over the open-mode limit, with `retryAfterSeconds` and a `Retry-After` header. A host application that embeds the news API module may supply its own key verifier and quota through `NewsApiModule.forRoot`; a refusal its verifier throws as a `GraphQLError` reaches the caller unchanged, also with HTTP status 200.

Search is for key holders only. In open mode `searchNews` always answers with the error code `SEARCH_NOT_OFFERED`, because each new search costs an embeddings call and an open server has no key to limit it by. To offer search, run the API with a key.

## Topic categories

The `canonicalTopics` query and the topic filter of `worldHeadlines` read a tree of categories that you seed yourself:

```
npm run seed-canonical-topics -- --allow-db <database>
npm run seed-canonical-topics -- --allow-db <database> --execute
```

`--allow-db` must name the database in `MONGODB_URI`, and the command refuses any other. Without `--execute` it only reports what it would write. It writes the first level of the tree, embeds each category with your embeddings provider, and links the articles of the last 48 hours to their category (`--backfill-window-hours` changes the window). After that, the worker links new articles as it embeds them, once it has reloaded the tree (at most an hour later). Until the tree is seeded, `canonicalTopics` answers an empty list.

Articles are linked only with the default Jina model at 768 dimensions, the model the link thresholds were tuned on. With another model the categories are still seeded, and a topic filter answers `NO_TOPIC_LINKS`.

The categories are the content categories of the Google Cloud Natural Language API (https://docs.cloud.google.com/natural-language/docs/categories), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

## Place data

Place search reads a `places` collection that you load yourself. Download `cities15000.zip` from https://download.geonames.org/export/dump/, unzip it, and run `npm run seed-places -- --file cities15000.txt`. Add `--admin1-file admin1CodesASCII.txt` (same page) for region names. Until the places are loaded, place search answers an empty list and `newsServerStatus` reports `placesSeeded: false`.

Place names from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

## Tests

```
npm test
npm run test:integration
```

The integration tests run against an in-memory MongoDB. The first run downloads a MongoDB server binary. End-to-end tests run in CI.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). If the AGPL does not fit your use, see [COMMERCIAL.md](COMMERCIAL.md). The names and logos are covered by [TRADEMARK.md](TRADEMARK.md).

## Contributing

Issues are welcome. Code contributions are not accepted yet.
