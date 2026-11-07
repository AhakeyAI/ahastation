import { readFileSync } from 'node:fs';
import { installGlobalHooks } from '../../dist-electron/global-hooks/installer.js';

try {
  const options = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(installGlobalHooks(options)));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code ?? error.message }));
  process.exitCode = 1;
}
