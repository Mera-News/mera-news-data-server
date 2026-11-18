# mera-news-data-server

The news data server behind Mera News, by Mera Labs B.V. It reads RSS feeds that publishers publish. It detects the language, translates, creates embeddings and stores articles in MongoDB. It serves topic-to-article retrieval and headlines over a GraphQL API. It has no user accounts and stores nothing about readers. It shows headlines and links out to the publisher. It does not summarise articles, and it is not a crawler: it reads published RSS only.

## What you need

- Node 24
- A MongoDB deployment with vector search and search indexes
- Redis
- An embeddings key: `JINA_API_KEY` (used when `EMBEDDING_PROVIDER` is `jina`, the default)
- A translation key: `GEMINI_API_KEY` (used when `TRANSLATION_PROVIDER` is `gemini`, the default, with `GEMINI_TRANSPORT=developer`, also the default. `GEMINI_TRANSPORT=vertex` uses Google application default credentials instead)

Set `EMBEDDING_PROVIDER=fake` and `TRANSLATION_PROVIDER=fake` to run offline without keys. The fake providers are for local runs and tests.

The other variables are in [apps/mera-server-async/.env.example](apps/mera-server-async/.env.example). The main ones are `MONGODB_URI`, `REDIS_URL` and `MERA_SERVER_ASYNC_API_KEY`. The news API refuses to start without `MERA_NEWS_API_KEY`.

Export the variables in your shell, or put them in a `.env` file. The ingest worker reads `apps/mera-server-async/.env`, `npm run load-rss` reads `apps/mera-scripts/.env`, and every service also reads a `.env` at the repository root. Run every command from the repository root.

## Set up MongoDB

1. Create a cluster in MongoDB Atlas.
2. Put its connection string in `MONGODB_URI`.
3. Create the indexes described in [CREATE_VECTOR_INDEX.md](CREATE_VECTOR_INDEX.md).

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

The server has no built-in scheduler. Ingest runs when something creates a job. The worker exposes `POST /invoke` for that. Send an `x-api-key` header that matches `MERA_SERVER_ASYNC_API_KEY`, and a JSON body with a `queue_name` and an optional `data` object:

```
curl -X POST http://localhost:8080/invoke \
  -H "x-api-key: $MERA_SERVER_ASYNC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"queue_name": "news-sync-fanout"}'
```

The `news-sync-fanout` queue creates a `load-rss-feed` job for each feed that is due, then translates and embeds what arrives. A `queue_name` that is not a known queue is refused with 400. Run the call from your own scheduler, such as cron, as often as you want new articles. Other valid queue names are listed in `libs/mera-shared/src/constants/queue-names.enum.ts`.

Grouping articles into stories is done by a separate clustering job that is not part of this repository.

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
