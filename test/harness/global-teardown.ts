import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown() {
  await (
    globalThis as { __HARNESS_MONGO__?: MongoMemoryReplSet }
  ).__HARNESS_MONGO__?.stop();
}
