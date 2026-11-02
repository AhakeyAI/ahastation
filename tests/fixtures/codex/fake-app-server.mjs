import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CODEX_METHOD_LOG) {
    appendFileSync(process.env.FAKE_CODEX_METHOD_LOG, `${message.method}\n`);
  }
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        userAgent: `Codex/${process.env.FAKE_CODEX_VERSION ?? '0.157.2'} (test)`,
        codexHome: '/isolated',
        platformFamily: 'test',
        platformOs: 'test',
      },
    })}\n`);
  }
  if (message.method === 'initialized') process.exit(0);
});
