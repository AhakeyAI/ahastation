import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Invalid stable semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    result[argv[index]] = argv[index + 1];
  }
  for (const key of ['--version', '--result', '--contract-status']) {
    if (!result[key]) throw new Error(`${key} is required`);
  }
  return result;
}

export async function prepareCompatibilityUpdate(options) {
  const version = parseVersion(options.version);
  const handshake = JSON.parse(await readFile(options.result, 'utf8'));
  const contractPassed = options.contractStatus === '0';
  const passed = handshake.ok === true && handshake.version === options.version && contractPassed;
  const sourcePath = resolve('electron/backends/codex-app-server-transport.ts');
  const source = await readFile(sourcePath, 'utf8');
  const currentText = source.match(/CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '([^']+)'/)?.[1];
  if (!currentText) throw new Error('Cannot locate Codex maximum verified version');
  const current = parseVersion(currentText);
  const updateRequired = !passed || compare(version, current) >= 0;
  let next = currentText;
  if (passed && updateRequired) {
    next = `${version[0]}.${version[1]}.${version[2] + 1}`;
    await writeFile(sourcePath, source.replace(
      /CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '[^']+'/,
      `CODEX_APP_SERVER_MAX_EXCLUSIVE_VERSION = '${next}'`,
    ));
  }
  const cardPath = resolve(`docs/plans/codex-compatibility-${options.version}.md`);
  await mkdir(dirname(cardPath), { recursive: true });
  await writeFile(cardPath, `# Codex ${options.version} 兼容性检查卡\n\n`
    + `- 日期：${new Date().toISOString()}\n`
    + `- initialize 握手：${handshake.ok ? '通过' : '失败'}\n`
    + `- adapter / transport 契约：${contractPassed ? '通过' : '失败'}\n`
    + `- 结论：${passed ? `已验证，建议版本门上界改为 <${next}` : '未通过，不得扩大已验证区间；需要人工修复后重跑'}\n`
    + '- 付费模型调用：无；账号读取：无。\n\n'
    + '```json\n' + JSON.stringify({ handshake, contractPassed }, null, 2) + '\n```\n');
  return { passed, updateRequired, previousMaxExclusive: currentText, nextMaxExclusive: next, cardPath };
}

async function main() {
  const options = args(process.argv.slice(2));
  const result = await prepareCompatibilityUpdate({
    version: options['--version'],
    result: options['--result'],
    contractStatus: options['--contract-status'],
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
