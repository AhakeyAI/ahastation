import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCodexRuntimeContract } from '../dist-electron/backends/codex-runtime.js';

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const parts = match?.slice(1).map(Number);
  if (!parts?.every(Number.isSafeInteger)) throw new Error(`Invalid stable semantic version: ${version}`);
  return parts;
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
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

async function checkBundledDependencies(bundled) {
  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve('package-lock.json'), 'utf8'));
  const sdk = '@openai/codex-sdk';
  if (pkg.dependencies?.[sdk] !== bundled || lock.packages?.['']?.dependencies?.[sdk] !== bundled
      || lock.packages?.['node_modules/' + sdk]?.version !== bundled) {
    throw new Error('Bundled Codex contract, package and dependency lock disagree');
  }
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!name.startsWith('node_modules/@openai/codex')) continue;
    if (typeof value.version !== 'string' || value.version.split('-')[0] !== bundled
        || !value.integrity?.startsWith('sha512-')) {
      throw new Error(`Bundled Codex dependency lock is inconsistent: ${name}`);
    }
  }
}

/** Prepare the upstream compatibility card, never apply a verified-range update.
 * The weekly workflow has no real model turn, so its handshake/contract results
 * cannot satisfy G8. A later authorized smoke and review must apply any change.
 */
export async function prepareCompatibilityUpdate(options) {
  const version = parseVersion(options.version);
  const current = readCodexRuntimeContract(resolve('contracts/runtime/codex.json'));
  await checkBundledDependencies(current.bundled);
  const handshake = JSON.parse(await readFile(options.result, 'utf8'));
  const handshakePassed = handshake?.ok === true && handshake.version === options.version;
  const contractPassed = options.contractStatus === '0';
  const checksPassed = handshakePassed && contractPassed;
  let candidateMaxExclusive = null;
  if (checksPassed && compare(version, parseVersion(current.maxExclusive)) >= 0) {
    if (!Number.isSafeInteger(version[2] + 1)) throw new Error('Candidate version upper bound is not a safe integer');
    candidateMaxExclusive = `${version[0]}.${version[1]}.${version[2] + 1}`;
  }
  const cardPath = resolve(`docs/plans/codex-compatibility-${options.version}.md`);
  await mkdir(dirname(cardPath), { recursive: true });
  await writeFile(cardPath, `# Codex ${options.version} 兼容性检查卡\n\n`
    + `- 日期：${new Date().toISOString()}\n`
    + `- initialize 握手及版本匹配：${handshakePassed ? '通过' : '失败'}\n`
    + `- adapter / transport 契约：${contractPassed ? '通过' : '失败'}\n`
    + `- 当前已验证区间：[${current.min}, ${current.maxExclusive})；内置版本 ${current.bundled}\n`
    + `- 结论：${checksPassed ? '握手和契约检查通过，仅生成候选；不代表 G8 已验证' : '检查未通过，需要人工修复后重跑'}\n`
    + (candidateMaxExclusive ? `- 候选上界：<${candidateMaxExclusive}，仅供后续真实冒烟及人工审核\n` : '- 候选上界：无，本次不建议更改当前区间\n')
    + '- G8 真实冒烟：本命令未执行或核验；握手、契约状态及附带元数据均不能代替。\n'
    + '- 自动应用：禁止；当前契约、transport、内置版本和依赖锁均未修改。\n'
    + '- 本命令付费模型调用：无；账号读取：无。\n\n'
    + '```json\n' + JSON.stringify({ handshake, contractPassed, checksPassed, candidateMaxExclusive }, null, 2) + '\n```\n');
  return {
    // The existing workflow also uses this flag for failure investigation.
    // Report failed checks; successful candidates never authorize range updates.
    passed: false,
    updateRequired: !checksPassed,
    canApply: false,
    checksPassed,
    requiresRealSmoke: true,
    previousMaxExclusive: current.maxExclusive,
    nextMaxExclusive: current.maxExclusive,
    candidateMaxExclusive,
    cardPath,
  };
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
