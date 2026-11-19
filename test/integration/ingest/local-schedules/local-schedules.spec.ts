import { QueueName } from '@mera/shared';
import { ConfigService } from '@nestjs/config';
import { bootAsyncApp } from '../../../harness/boot';
import { parseLocalSchedules } from '../../../../apps/mera-server-async/src/modules/local-schedules/local-schedules.service';

const IDS = [
  'news-sync-fanout',
  'link-all-topics-to-clusters',
  'data-retention-hourly',
  'data-retention-daily',
];

const reader = (value?: string) =>
  new ConfigService(value === undefined ? {} : { LOCAL_SCHEDULES: value });

/**
 * Boots the app with LOCAL_SCHEDULES set and always restores it. Unset is '',
 * as the harness does: a deleted key would be refilled from a .env file.
 */
async function bootWith(value: string) {
  const saved = process.env.LOCAL_SCHEDULES;
  process.env.LOCAL_SCHEDULES = value;
  const harness = await bootAsyncApp();
  try {
    return {
      upserts: Object.values(harness.queues).flatMap((q) =>
        q.schedulers.map((s) => ({ queue: q.name, ...s })),
      ),
      removed: Object.values(harness.queues).flatMap((q) =>
        q.removedSchedulers.map((id) => ({ queue: q.name, id })),
      ),
    };
  } finally {
    await harness.close();
    if (saved === undefined) delete process.env.LOCAL_SCHEDULES;
    else process.env.LOCAL_SCHEDULES = saved;
  }
}

describe('parseLocalSchedules', () => {
  it('reads true and false', () => {
    expect(parseLocalSchedules(reader('true'))).toBe(true);
    expect(parseLocalSchedules(reader('false'))).toBe(false);
  });

  it('treats unset and empty as off', () => {
    expect(parseLocalSchedules(reader())).toBe(false);
    expect(parseLocalSchedules(reader(''))).toBe(false);
  });

  it('refuses any other value, naming the key', () => {
    expect(() => parseLocalSchedules(reader('yes'))).toThrow('LOCAL_SCHEDULES');
  });
});

describe('local schedules at boot', () => {
  it('on: upserts the four schedulers and removes none', async () => {
    const { upserts, removed } = await bootWith('true');
    expect(removed).toEqual([]);
    const sorted = [...upserts].sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted).toEqual(
      [
        [
          QueueName.DATA_RETENTION_SWEEP,
          'data-retention-daily',
          '15 3 * * *',
          {},
        ],
        [
          QueueName.DATA_RETENTION_SWEEP,
          'data-retention-hourly',
          '0 * * * *',
          { skipOrphans: true },
        ],
        [
          QueueName.LINK_ALL_TOPICS_TO_CLUSTERS,
          'link-all-topics-to-clusters',
          '20 * * * *',
          {},
        ],
        [QueueName.NEWS_SYNC_FANOUT, 'news-sync-fanout', '0 * * * *', {}],
      ].map(([queue, id, pattern, data]) => ({
        queue,
        id,
        repeat: { pattern },
        template: { name: `scheduled-${id as string}`, data },
      })),
    );
  });

  it('explicitly off: removes the four schedulers and upserts none', async () => {
    const { upserts, removed } = await bootWith('false');
    expect(upserts).toEqual([]);
    expect(removed.map((r) => r.id).sort()).toEqual([...IDS].sort());
  });

  // Unset is every deployment that never asked for local schedules: its boot
  // must not reach Redis for them at all, so a Redis outage cannot hold it up.
  it('unset: touches no scheduler', async () => {
    const { upserts, removed } = await bootWith('');
    expect(upserts).toEqual([]);
    expect(removed).toEqual([]);
  });
});
