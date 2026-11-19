import { Logger } from '@nestjs/common';
import type { Db } from 'mongodb';
import { readText, type ConfigReader } from '../config/env-choice';
import {
  CALIBRATED_JINA_MODEL,
  embeddingDims,
  embeddingProvider,
} from './embedding-config';

const logger = new Logger('EmbeddingMeta');

const DUPLICATE_KEY = 11000;

/** A refusal, told apart from a database error, which only logs. */
class EmbeddingMismatchError extends Error {}

const RESOLUTION =
  'Change model or start over: set the model and EMBEDDING_DIMS back to what the database was built with, or use a new database.';

interface EmbeddingMeta {
  provider: string;
  model: string;
  dims: number;
}

function expectedMeta(config: ConfigReader): EmbeddingMeta {
  const provider = embeddingProvider(config);
  return {
    provider,
    model:
      provider === 'openai-compatible'
        ? readText(config, 'EMBEDDING_MODEL')
        : readText(config, 'JINA_MODEL') || CALIBRATED_JINA_MODEL,
    dims: embeddingDims(config),
  };
}

/** `provider` is recorded for information only: the same model through another adapter is the same vectors. */
function assertSameVectors(stored: EmbeddingMeta, expected: EmbeddingMeta) {
  if (stored.model === expected.model && stored.dims === expected.dims) return;
  throw new EmbeddingMismatchError(
    `This database holds vectors from "${stored.model}" at ${stored.dims} dimensions, but the configuration says "${expected.model}" at ${expected.dims}. ${RESOLUTION}`,
  );
}

/**
 * Refuses to run an embedder whose model or dimensions differ from the ones
 * this database's vectors were made with. Only `write: true` callers (the
 * pipeline and the seed command) record the document; the rest compare. A
 * database error is logged and skipped, as every other read would be failing.
 */
export async function checkEmbeddingMeta(
  db: Db,
  config: ConfigReader,
  { write }: { write: boolean },
): Promise<void> {
  const expected = expectedMeta(config);
  const meta = db.collection<EmbeddingMeta & { _id: string; createdAt: Date }>(
    'deployment-meta',
  );
  try {
    const stored = await meta.findOne({ _id: 'embedding' });
    if (stored) {
      assertSameVectors(stored, expected);
      return;
    }
    if (!write) return;

    const sample = await db.collection('news-article').findOne(
      // A non-empty array only: the schema defaults the field to [], so every
      // article not embedded yet holds one, and `$size` fails on null.
      { 'embedding_article_data_retrieval.0': { $exists: true } },
      {
        projection: {
          length: { $size: '$embedding_article_data_retrieval' },
        },
      },
    );
    if (sample && sample.length !== expected.dims) {
      throw new EmbeddingMismatchError(
        `Stored article vectors have ${sample.length} dimensions, but EMBEDDING_DIMS is ${expected.dims}. ${RESOLUTION}`,
      );
    }
    try {
      await meta.insertOne({
        _id: 'embedding',
        ...expected,
        createdAt: new Date(),
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== DUPLICATE_KEY) throw error;
      // Another process won the race: its document decides, never skip the compare.
      const winner = await meta.findOne({ _id: 'embedding' });
      if (winner) assertSameVectors(winner, expected);
    }
  } catch (error) {
    if (error instanceof EmbeddingMismatchError) throw error;
    logger.error(
      `Could not check the embedding meta document: ${String(error)}`,
    );
  }
}
