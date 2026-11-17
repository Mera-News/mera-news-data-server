# mera-news-data-server

The news data server behind Mera News, by Mera Labs B.V. It reads RSS feeds that publishers publish. It detects the language, translates, creates embeddings and stores articles in MongoDB. It serves topic-to-article retrieval and headlines over a GraphQL API. It has no user accounts and stores nothing about readers. It shows headlines and links out to the publisher. It does not summarise articles, and it is not a crawler: it reads published RSS only.

## What you need

- Node 24
- A MongoDB deployment with vector search and search indexes
- Redis
- An embeddings key: `JINA_API_KEY` (used when `EMBEDDING_PROVIDER` is `jina`, the default)
- A translation key: `GEMINI_API_KEY` (used when `TRANSLATION_PROVIDER` is `gemini`, the default)

Set `EMBEDDING_PROVIDER=fake` and `TRANSLATION_PROVIDER=fake` to run offline without keys. The fake providers are for local runs and tests.

The other variables are in [apps/mera-server-async/.env.example](apps/mera-server-async/.env.example). The main ones are `MONGODB_URI`, `REDIS_URL` and `MERA_SERVER_ASYNC_API_KEY`. The news API refuses to start without `MERA_NEWS_API_KEY`.

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

- `npm run load-rss` loads the feed list into the database.
- `npm run async` starts the ingest worker. It listens on `PORT`, or `ASYNC_PORT` (default 8080).
- `npm run news-api` starts the GraphQL news API. It listens on `PORT`, or `NEWS_API_PORT` (default 3002).

The server has no built-in scheduler. Ingest runs when something creates a job. The worker exposes `POST /invoke` for that. Send an `x-api-key` header that matches `MERA_SERVER_ASYNC_API_KEY`, and a JSON body with a `queue_name` and an optional `data` object:

```
curl -X POST http://localhost:8080/invoke \
  -H "x-api-key: $MERA_SERVER_ASYNC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"queue_name": "news-sync-fanout"}'
```

The `news-sync-fanout` queue creates a `load-rss-feed` job for each feed. Run the call from your own scheduler, such as cron, as often as you want new articles. Other valid queue names are listed in `libs/mera-shared/src/constants/queue-names.enum.ts`.

## Tests

```
npm test
npm run test:integration
```

End-to-end tests run in CI.

## License

AGPL-3.0-only. See [LICENSE](LICENSE). If the AGPL does not fit your use, see [COMMERCIAL.md](COMMERCIAL.md). The names and logos are covered by [TRADEMARK.md](TRADEMARK.md).

## Contributing

Issues are welcome. Code contributions are not accepted yet.
