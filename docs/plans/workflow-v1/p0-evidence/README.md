# Workflow V1 — P0 能力验证实测证据与复现脚本

本目录保存 [07-validation-and-rollout.md](../07-validation-and-rollout.md) 定义的 **P0-A ~ P0-I** 全部 9 项能力验证的原始实测 JSON 报告与可复现离线验证脚本。所有脚本均通过本地回环 Mock HTTP 服务（`/v1/messages`、`/v1/responses`、`/repos/:owner/:repo/pulls`）和本地临时 Git 裸仓执行，**不消耗任何真实模型 API 额度，也不向外部远端仓库推送**。

## 1. 实测环境基线

- **操作系统**：Windows 11 (`win32-x64`)
- **Electron / Node / SQLite**：`Electron 42.11.18` / `Node v24.19.0` / 内置 `node:sqlite` (`SQLite 3.53.3`)
- **PTY 后端**：`@lydell/node-pty` (`1.2.0-beta.12`，Windows ConPTY)
- **Git**：`git.exe 2.52.0.1`
- **Worker / Host CLI**：`claude-code 2.1.318`、`codex-cli 0.167.0`

## 2. 报告与脚本对应索引

| 验证项 | 实测报告 JSON | 复现脚本 | 覆盖内容 |
|---|---|---|---|
| **P0-A / P0-B / P0-H** | [p0-a-b-h-report.json](p0-a-b-h-report.json) | [p0-a-b-h-cli-hooks-verify.mjs](p0-a-b-h-cli-hooks-verify.mjs)、[probe-claude-interactive-tui.mjs](probe-claude-interactive-tui.mjs) | Claude `2.1.318` 与 Codex `0.167.0` 的 `SessionStart`、`UserPromptSubmit`、`Stop` hooks 载荷、交互式 ConPTY 空闲提示符 `idle-wake`（bracketed paste + `\r`）唤醒，以及 `--resume` / `resume` 携带首条指令 (`resume-with-instruction`) 与上下文保留 |
| **P0-C / P0-D** | [p0-c-d-report.json](p0-c-d-report.json) | [p0-c-d-process-terminal-verify.mjs](p0-c-d-process-terminal-verify.mjs) | Windows ConPTY 同步 `pid=0` 与异步真实 PID 采集、轮次停止后后台写入子进程存活证明、`taskkill /t /f` + `Win32_Process` 进程树清理（`survivors = 0`）、UTF-8 多字节与 ANSI CSI 安全检查点边界回退及 `64KB/16ms` 批量刷盘性能 |
| **P0-E** | [p0-e-report.json](p0-e-report.json) | [p0-e-sqlite-verify.mjs](p0-e-sqlite-verify.mjs) | Electron 内置 `node:sqlite` (`DatabaseSync`) 在 `WAL + foreign_keys=ON` 下 `synchronous=FULL` 与 `NORMAL` 的 200 次单事务提交延迟分位数、`VACUUM INTO` 在线备份及子进程 `SIGKILL` 崩溃恢复验证 |
| **P0-F / P0-I** | [p0-f-i-report.json](p0-f-i-report.json) | [p0-f-i-git-delivery-verify.mjs](p0-f-i-git-delivery-verify.mjs) | 干净/脏工作树候选快照冻结、分支归属校验 (`RV-27`)、非检出分支 `update-ref` 原子 CAS、已检出工作树 `git merge --ff-only` (`RV-12a/b/c`)、恶意 `.git/hooks` 与 `core.fsmonitor` 隔离 (`RV-19`)、首次推送空预期值 `--force-with-lease=<ref>:` (`RV-23`/`RV-29`) 及 PR Diff 快照与离线 GitHub API 核对 |
| **P0-G** | [p0-g-report.json](p0-g-report.json) | [p0-g-codex-host-verify.mjs](p0-g-codex-host-verify.mjs) | `codex app-server --stdio` 在 `capabilities: { experimentalApi: true }` 下的原生 `dynamicTools` 注册、`item/tool/call` 拦截与回执、`turn/interrupt` 中断，以及进程强杀重启后 `thread/resume` + `thread/turns/list(itemsView:'full')` 的 `callId` 持久性 |

## 3. 本地复现运行方式

在仓库根目录下使用 Electron 内置 Node 运行时执行任意脚本（可通过环境变量 `CLAUDE_BIN`、`CODEX_BIN`、`GIT_EXE` 覆盖二进制路径）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/p0-e-sqlite-verify.mjs
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/p0-f-i-git-delivery-verify.mjs
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/p0-g-codex-host-verify.mjs
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/p0-c-d-process-terminal-verify.mjs
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/p0-a-b-h-cli-hooks-verify.mjs
.\node_modules\electron\dist\electron.exe docs/plans/workflow-v1/p0-evidence/probe-claude-interactive-tui.mjs
```
