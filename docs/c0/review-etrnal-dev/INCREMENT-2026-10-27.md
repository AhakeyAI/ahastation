# `etrnal-dev` 增量复核（2026-10-27）

对象：`etrnal-dev` @ `295e1ba`（业务源码 `e0c940a`，基于 main `c8295b9`），以及由它开出的草稿 PR #55。上一轮评审针对 `5f76c3a`，见 [README.md](README.md)。

分支已经改写：作者把它 rebase 到 `c8295b9`，并重新整理了提交，所以不能从 `5f76c3a` 直接 diff。下面的结论都基于剔除 PR #47 改动后的差异。

## 1. 结论

| 项 | 结论 |
| --- | --- |
| **B1 K01（一票否决）** | **已修复，解除阻断** |
| 新 P1：旧 attempt 的完成收据授权新 attempt 发布 | 已修复，回归覆盖到位 |
| B3 基线落后 | 部分解决：已整合 PR #47，还没整合运行时修复（PR #54） |
| **B2 Codex 版本写死** | **仍是阻断**：从 0.144.1 改成了 0.164.0，但还是三处精确匹配，和 G8、PR #54 冲突，见 §3 |
| **新增 S1：同步 `safeStorage` 接口** | **合入 PR #53 之前必须改**，见 §4 |
| N1–N6 | 都还没改；作者说会按新提交逐项核对 |
| PR #55 | 现在不能整体合入，条件见 §6 |

## 2. K01 与新 P1

**代码核对：**

- `electron/collaboration/station-service.ts:1047`（`authorizeDelivery`）现在要求本机记录和收据**都**是 `exitConfirmed` 且 `turnOutcome === 'completed'`，否则抛错，并保留成果；
- 原来交付时补出 `completed` 的 `?? 'completed'` 已删除；
- 新增 `electron/collaboration/execution.ts:9` 的 `executionOutcome`：只认适配器明确报告的结果，`ok` 和退出码不能代替完成证据，缺失时为 `unknown`；
- 所有 commit、push、PR、选定文件和文字成果的发布都要再经过 `authorizeDelivery`；
- Hub 侧对缺少完成证据的 `delivered` 事件返回 `409 TURN_COMPLETION_UNCONFIRMED`（`contracts/collaboration/COMPLETION_EVIDENCE.md`）。

**本机运行**（隔离环境，做法同 README §6：`env -i`、临时 HOME、PATH 里没有 Agent 命令、`lsof` 记录对外连接）：

- K01 组：`executed` / `delivery-pending` × 缺失、`unknown`、`failed`、`interrupted`、`completed`，全部通过；
- P1 组：新旧任务与收据混用、旧调用方、旧快照，以及文件选择、确认、收据写入期间换代，共 10 个场景全部通过，并记录了副作用：新 commit、分支、worktree、push、PR、模型调用、检查都是 0；
- 正常的同一 attempt 发布仍然通过。

上一轮 R1 提出的三条回归要求（字段缺失时零副作用、有证据时恢复且不重跑、重启后再核对）都已覆盖。作者的复现脚本 `scripts/review/reproduce-legacy-outcome.mjs` 已经重写，不再作为判定依据。

## 3. Codex 版本（B2，仍阻断）

三处都精确写死了 0.164.0：

- `electron/backends/codex-app-server-transport.ts:23`、`:90`（`!==` 比较）；
- `electron/backends/worker-runtime-contract.ts:14`；
- `services/remote/device/station_codex.py:170`。

和 PR #54 直接冲突：PR #54 内置 0.156.1，版本门是区间 `[0.156.1, 0.157.0)`。两边一合并，就必须二选一。

按 G8，只有跑过真实冒烟的版本才算已验证：

| 版本 | 证据 |
| --- | --- |
| 0.156.1 | B04 严格复验 S1–S10 通过（`../b04-runtime/README.md` §6d） |
| 0.164.0 | 只有握手：N5095 的 initialize（`../results/n5095-codex-latest-20261027.json`），以及作者的本地回归；没有真实执行证据，作者自己也把「真实模型执行」列为未验收 |

**建议**：

- 整合时以 PR #54 为准：内置 0.156.1，用区间版本门；
- Python 侧不要自己写版本号，改为读同一个区间；
- 要把 0.164.0 纳入区间，先在它上面重跑 B04 的 S1–S6（会用到 Codex 额度，需要用户授权），然后由每周兼容检查扩大区间。

## 4. 新发现 S1：同步 `safeStorage` 接口

`etrnal-dev` 有 4 处使用同步接口：

- `electron/bootstrap.ts:20-27`
- `electron/collaboration/device-credential.ts:11`、`:27`
- `electron/collaboration/station-service.ts:168`
- `electron/store.ts`：`remoteControl.controlToken` 的加解密，以及 `remoteCredentialStorageAvailable`

同步接口在 Electron 45 已弃用，46 会删除。PR #53 已经把 `store.ts` 改成启动时异步解密、写入时异步加密（`warmSecrets`）。rebase 到 PR #53 之后：

- `store.ts` 里的 `tryEncryptKey(controlToken)` 会返回 Promise，typecheck 能拦住；
- 另外三处直接调用 `safeStorage`，不会报错，但升级到 46 时会坏。

**要求**：设备凭据和控制 token 都改用异步接口，并入 `warmSecrets` 的启动解密。ADR 0017 也要求设备密钥放在异步 safeStorage 里。

## 5. 其他问题的状态

| # | 状态 | 说明 |
| --- | --- | --- |
| N1 可读性 | 未改，更严重了 | `station-service.ts` 现在 1466 行，71 行超过 300 字符（上一轮是 59 行） |
| N2 可信代理 | 未改 | `public_hub.py:165`、`:191` 仍按 `request.client.host` 限流 |
| N3 路径校验 | 未改 | `git-files.ts:20` 的 `safeRelative` 没变，在 POSIX 上 `C:/private`、`C:private` 都能通过。本机「真实 Git 传输」用例仍然因此失败 |
| N4 测试离线 | 未改 | 本轮仍有 Qoder CLI 登录检查连到 203.107.1.1、8.212.124.35，以及 npm 的版本检查；没有出现公网 Hub 的地址 |
| N5 两台 Station 用例 | 未改 | 清理时仍报 `ENOTEMPTY` |
| N6 提示词与本机路径 | 未改 | 3 个 `*PROMPT*` 文件还在；原验证机的用户名 `79142` 出现在 18 个文件里，其中 12 个是 `C:/Users/79142` 这类完整路径 |
| K02 | 未定位 | 作者已保留脱敏的 RPC 原因和关联 ID，根因仍待查 |
| **新 S2：上游来源** | 待确认 | `services/remote/` 来自 `Dryoung95/pocket-vibe-agent`（`UPSTREAM_SOURCE.json`），声明里写着「含未提交改动」，目录里也没有许可证文件。如果是团队自己的代码，补一句授权说明即可 |
| **新 S3：测试并发** | 讨论 | `npm test` 改成了 `--test-concurrency=1`。这能避开并发下的超时，但也会掩盖 P7 里那类时序问题，而且会和 main 的测试脚本冲突 |
| **新 S4：文档说法不一致** | 小问题 | `LOCAL_INTEGRATION_VALIDATION_2026-10-27.md` 写着「当前不创建 PR」，而 PR #55 已经开了 |
| ADR | 无冲突 | 0013–0016 是从 PR #50 原样复制的，内容一致；只有 `docs/adr/README.md` 三方各不相同，合并时手动合即可 |

**本机 `npm run test:collaboration` 的结果：**
- Python 部分 12 组全部通过；
- Node 部分 217 项：186 通过，29 失败，2 跳过。

29 个失败逐个核实过：

| 失败 | 原因 | 性质 |
| --- | --- | --- |
| 24 个 `stability-ui` / `ui-fixes-browser` 用例 | Playwright 浏览器没有下载（本机安装依赖时跳过了） | 环境 |
| F10 全链路 | 包含界面步骤，断言失败；很可能也是浏览器缺失，没有单独确认 | 待确认 |
| H11/H12 真实本机 Git | macOS 不支持执行 | D3 |
| F2 Hub 重启 | 固定端口重新绑定时 `Address already in use` | 测试夹具 |
| 两台 Station 共享 Hub | `ENOTEMPTY` | N5 |
| 真实 Git 传输 | `safeRelative` | N3 |

除了浏览器缺失以外，剩下的失败和上一轮完全一致，没有新的逻辑失败。作者报的全量 `npm test` 1192 项是在 Windows 上跑的，没有在 Mac 上重复。

## 6. PR #55（382 个文件，+51k 行）

**构成：**

| 部分 | 规模 |
| --- | --- |
| `docs/collaboration` | 约 9.6k 行 |
| `services/remote` | 约 20k 行，含 Hub、原生组件、测试和文档 |
| `contracts/collaboration` | 7.4k 行 |
| Node 测试 | 3.5k 行 |
| `electron/collaboration` | 3.4k 行 |
| UI | 约 1.5k 行 |

**建议：**

- PR #55 保持草稿，只作为评审入口；
- 合入前要满足：
  1. 在 PR #54、#53 合入后的 main 上 rebase；
  2. Codex 版本按 §3 统一；
  3. `safeStorage` 按 §4 改成异步接口；
  4. N3（路径校验）和 N6（提示词与本机路径）修掉；N2 在接公网 Hub 之前修掉；
  5. 补上上游来源和授权说明（S2）。
- **分批合入**：按依赖顺序（契约和文档 → Hub → Station → UI），每批单独跑三平台 CI。如果作者坚持一次合入，协作入口要默认关闭，等 A-13 / X1（签名与验签）完成后再打开，这样才符合 ADR 0017「内部验收阶段要求设备签名」。
- 文档减量：过程性的修复报告和提示词移到证据目录，或者不进 main。
