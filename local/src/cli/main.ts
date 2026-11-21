import { run } from './run.ts';

const code = await run(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), tty: !!process.stdout.isTTY }, { env: process.env });
// Wait for the output to drain, then leave even if a model runtime keeps a handle open.
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
