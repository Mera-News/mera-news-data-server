import { InjectConnection } from '@nestjs/mongoose';
import { Command, CommandRunner, Option } from 'nest-commander';
import type { Connection } from 'mongoose';
import { LinkTopicsToClustersStatus } from '@mera/models/models/state-machine-link-topics-to-clusters.model';

const STAGES = ['embedded', 'clustered', 'linked', 'edition'] as const;
type Stage = (typeof STAGES)[number];

interface StatusCommandOptions {
  check?: string;
}

const RECENT_HOURS = 48;

@Command({
  name: 'status',
  description:
    'Print how far the news pipeline has got: feeds, articles, clusters, topics and editions',
})
export class StatusCommand extends CommandRunner {
  constructor(@InjectConnection() private readonly connection: Connection) {
    super();
  }

  @Option({
    flags: '--check <stage>',
    description:
      'Exit 1 unless this stage has at least one record: embedded, clustered, linked or edition.',
  })
  parseCheck(stage: string): string {
    return stage;
  }

  async run(_args: string[], options?: StatusCommandOptions): Promise<void> {
    const check = options?.check;
    const stage = STAGES.find((s) => s === check);
    if (check !== undefined && stage === undefined) {
      throw new Error(
        `--check takes one of: ${STAGES.join(', ')} (got "${check}")`,
      );
    }

    const db = this.connection.db!;
    const count = (collection: string, filter = {}) =>
      db.collection(collection).countDocuments(filter);
    const since = new Date(Date.now() - RECENT_HOURS * 60 * 60 * 1000);
    const recent = { createdAt: { $gte: since } };

    const [active, inactive, refused, stored, embedded, clusters] =
      await Promise.all([
        count('publication-source', { is_active: true }),
        count('publication-source', { is_active: false }),
        count('publication-source', { last_fetch_status: 'refused' }),
        count('news-article', recent),
        count('news-article', {
          ...recent,
          'embedding_article_data_retrieval.0': { $exists: true },
        }),
        count('news-cluster'),
      ]);
    const [topics, linkedTopics] = await Promise.all([
      count('user-topic'),
      db.collection('topic-cluster-link').distinct('topicId'),
    ]);
    const lastRun = await db
      .collection('state-machine-link-topics-to-clusters')
      .findOne<{
        status?: string;
        createdAt?: Date;
      }>({}, { sort: { createdAt: -1 } });
    const editions = await count('headline-edition');
    const newestEdition = await db.collection('headline-edition').findOne<{
      status?: string;
      createdAt?: Date;
    }>({}, { sort: { createdAt: -1 } });

    const when = (date?: Date) => (date ? date.toISOString() : 'never');
    console.log(
      `feeds: ${active} active, ${inactive} inactive, ${refused} refused`,
    );
    console.log(
      `articles in the last ${RECENT_HOURS} hours: ${stored} stored, ${embedded} embedded`,
    );
    console.log(`clusters: ${clusters}`);
    console.log(
      `topics: ${topics}, linked to clusters: ${linkedTopics.length}`,
    );
    console.log(
      `last topic link run: ${
        lastRun ? `${lastRun.status} at ${when(lastRun.createdAt)}` : 'none'
      }`,
    );
    console.log(
      `headline editions: ${editions}, newest ${when(newestEdition?.createdAt)}`,
    );

    if (stage === undefined) return;
    const passed: Record<Stage, boolean> = {
      embedded: embedded > 0,
      clustered: clusters > 0,
      // The run only enqueues per-topic jobs; links existing is the finish.
      linked:
        lastRun?.status === LinkTopicsToClustersStatus.ENQUEUE_SUCCESS &&
        linkedTopics.length > 0,
      edition: editions > 0,
    };
    if (!passed[stage]) {
      console.log(`check failed: nothing at the ${stage} stage yet`);
      process.exitCode = 1;
    }
  }
}
