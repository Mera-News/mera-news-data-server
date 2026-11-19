# Seed data

- `google-nlp-categories.json` lists the content categories of the Google Cloud Natural Language API (https://docs.cloud.google.com/natural-language/docs/categories), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The topic categories that `npm run seed-canonical-topics` writes are built from it.
- `active-feeds-auto-generated.json` is the feed list that `npm run load-rss` loads.
- Place data is not bundled. `npm run seed-places` reads a file you download from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). See the main README.
