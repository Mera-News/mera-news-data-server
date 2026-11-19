import { MongoClient } from 'mongodb';

// Every test file starts with no embedding meta document. The per-worker
// database is shared by every suite on that worker, and a document left by an
// earlier file (another model, a planted test value) makes each later boot
// refuse to start.
beforeAll(async () => {
  const client = new MongoClient(process.env.MONGODB_URI!);
  try {
    await client.connect();
    await client.db().collection('deployment-meta').deleteMany({});
  } finally {
    await client.close();
  }
});
