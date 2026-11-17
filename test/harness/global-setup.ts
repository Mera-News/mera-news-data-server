import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Pinned so a local run and CI test against the same server version.
export const MONGOD_VERSION = '8.2.6';

export default async function globalSetup() {
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: MONGOD_VERSION },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  (globalThis as { __HARNESS_MONGO__?: MongoMemoryReplSet }).__HARNESS_MONGO__ =
    replSet;
  // Workers inherit this; each one picks its own database (see env.ts).
  process.env.HARNESS_MONGO_URI = replSet.getUri();
}
