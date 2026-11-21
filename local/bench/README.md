# Local mode measurements

Scripts that measure embedding models and vector scans on a small frozen sample of real feeds. Plain Node 24 or newer, no build step.

    cd local/bench && npm install

Every script takes `--dir <path>`, a folder you choose. Nothing in this folder is committed: the sample, the model files and all results stay in your `--dir`.

## 1. Freeze the sample

    node sample.mjs --dir <path> --user-agent "<who you are and how to reach you>"

Picks 60 feeds from `apps/mera-scripts/seed-data/active-feeds-auto-generated.json` (about 10 each of en, es, fr, de, pt, hi; https only; one per host), fetches each once, one second apart, and never retries. A rerun skips every feed already in the log, failed ones included. `--user-agent` is required.

## 2. Measure a model

    node measure.mjs --dir <path> --model <e5-small|bge-m3|qwen3-0.6b|jina-v5-nano-nc> [--force] [--limit N]

Stages: load, embed 5,000 items, 30 topic queries, vector scans at 20,000 and 100,000 random vectors (`sqlite-vec` against plain JavaScript), and a one-time licence check. Each stage is checkpointed, so a rerun skips what is done; `--force` redoes everything. `--limit N` shrinks the embed stage to N items and the scans to 2,000 and 5,000 vectors, for a smoke run.

## 3. Build the blind rater input

    node measure.mjs --dir <path> --blind

Lists the top 10 of each measured model per topic under shuffled letters, with the key kept apart.

## Output files (all under `--dir`)

| Path | What |
|---|---|
| `sample/items.json`, `sample/fetch-log.json` | the frozen items, and per-feed status and item count |
| `models/` | downloaded model files |
| `checkpoints/<model>.json` | stage progress and raw numbers |
| `vectors/<model>.f32` | one float32 vector per real item, in sample order |
| `results/<model>.json` | top 10 items for each topic in `topics.json` |
| `summary/<model>.json` | load, embed, memory and scan numbers |
| `licence.json` | what `npm ls sharp` shows, and whether embedding works without sharp |
| `rater/lists.json`, `rater/key.json` | blind lists, and the letter to model key |
| `scan/` | temporary scan databases, deleted after each stage |

## Licence note

`jina-v5-nano-nc` is the Jina v5 nano retrieval model, released under CC BY-NC 4.0 (non-commercial). It is measured only as an opt-in candidate and is not a default. The other three models are MIT or Apache-2.0.
