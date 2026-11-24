# mera-news-data-server

The news data server behind Mera News, by Mera Labs B.V. It reads RSS feeds that publishers publish. It detects the language, translates, creates embeddings and stores articles in MongoDB. It serves topic-to-article retrieval and headlines over a GraphQL API. It has no user accounts and stores nothing about readers. It shows headlines and links out to the publisher. It does not summarise articles, and it is not a crawler: it reads published RSS only.

Mera News, the app, runs this code inside a private service that adds accounts, subscriptions and push notifications. Those private parts are not published.

## Run your own

[docs/self-host.md](docs/self-host.md) takes you from nothing to your own server, on a laptop or on a cloud machine: MongoDB Atlas, Redis, your choice of embeddings and translation, your own feeds, and the queries.

What you need:

- Node.js 24 or newer, and npm
- A MongoDB Atlas cluster (the free tier is enough to try it). MongoDB Community Edition with its search process is not tested yet: see the guide, step 5.
- Redis 7
- A Jina API key, or any OpenAI-compatible embeddings server, such as Ollama on your own machine

The quickest try: a free Atlas cluster, Redis in Docker, a local embeddings model with Ollama, no translation, and the news API open on 127.0.0.1 only. The guide walks through exactly that first.

Every setting, with its default, is in the guide; [.env.example](.env.example) holds the same settings block.

## What this code can and cannot prove

Mera's production servers run this repository's code inside private services: the ingest code inside Mera's worker, and the retrieval code inside the app's API. Mera also runs the standalone news API from this repository, built from `Dockerfile.news-api`, at `https://api.mera.news/graphql` for callers with a key. The builds are not reproducible or signed, and the deployed commit is not published, so this code alone cannot prove what Mera's servers run. To depend on none of that, run it yourself: see [Run your own](#run-your-own).

## Using the news API module in your own application

`NewsApiModule.forRoot({ imports, apiKeyVerifier, articleQuota })` lets a host application supply its own key verifier and quota, with the modules they depend on. With no options it is what `npm run news-api` serves. A refusal the verifier throws as a `GraphQLError` reaches the caller unchanged; every refusal is HTTP status 200, with the reason in the error's `extensions.code`.

## Tests

```
npm test
npm run test:integration
```

The integration tests run against an in-memory MongoDB. The first run downloads a MongoDB server binary. End-to-end tests run in CI.

## Data sources

Place names from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

The topic categories are the content categories of the Google Cloud Natural Language API (https://docs.cloud.google.com/natural-language/docs/categories), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

## Licence

Copyright Mera Labs B.V.

Required Notice: Copyright Mera Labs B.V. (https://mera.news)

This code is source-available under the PolyForm Shield License 1.0.0. See `LICENSE`.

In short: you may run it, change it and build on it for any purpose, except to provide a product
that competes with this software or with a product Mera Labs provides using it, such as Mera News.
This summary is not the licence. The `LICENSE` file is.

Mera News and Mera Protocol are trademarks. See `TRADEMARK.md`.
For a use the licence does not allow, see `COMMERCIAL.md`.
To contribute, see `CONTRIBUTING.md`.

## Contributing

Issues and pull requests are welcome. See `CONTRIBUTING.md`.
