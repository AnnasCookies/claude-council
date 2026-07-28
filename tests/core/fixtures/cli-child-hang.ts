import { join } from 'node:path';

Bun.spawn([process.execPath, join(import.meta.dir, 'cli-hang.ts')], {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
});
await Bun.sleep(60_000);
