# 0018 跨设备执行端复用 TS adapter

- 状态：已接受（2026-10-26，用户裁决冲突表 C03、C04、C05；10-27 补 C14）
- 日期：2026-10-27
- 关联：ADR 0016、D14、G4、G8、A-14–A-20；R1 评审 B2、D2、D3；`etrnal-dev` 的 `services/remote/device/station_codex.py`、`codex_shared_service.py`

## 背景

`etrnal-dev` 的执行端由 Python 接收组件直接驱动 Codex app-server：

- 版本写死为 0.144.1（`station_codex.py:142`）；
- 沙箱用 `workspace-write`，审批用 `untrusted`（`:90`、`:157`）；
- 守护进程（guardian）只实现了 Windows Job 和 Linux 进程树，macOS 直接拒绝执行（`:100-104`）。

C0 的 TS adapter 同样走 Codex app-server（`electron/backends/codex-app-server-transport.ts`），已经在 A-14–A-20 中改成 `read-only + on-request`、版本区间（G8）、获批命令 hash 比对（G4），并通过了 B04 的一票否决场景。两套驱动并存，会让同一类授权问题分别出现两次。

## 决定

1. 跨设备任务在执行设备上**通过 TS adapter 执行**，与本机任务走同一条路径、同一套授权映射和停止语义（A-20）。
2. Python 接收组件只负责接收、持久化、核对和守护进程隔离，不再自己启动 Codex 线程。具体接法在 R3 评估：
   - 由 guardian 作为启动器包住 adapter 拉起的进程；
   - 或者把 guardian 移到 TS 侧。
3. 远程接续已有 Codex 对话（`etrnal-dev` ADR 0002 / 0010）作为 TS adapter 的新能力实现。只接续权限不超过执行设备本机项目授权的对话（`read-only` / `on-request`）；完全访问或 `workspace-write` 的对话显示「需要在本机桌面继续」，不远程驱动（C04）。
4. 首轮双机验收由 Mac 协调、N5095 执行（C05）。macOS 执行端（guardian 的进程组和进程树核对）作为后续卡，排在首轮之后，但必须在首次公开可用之前完成。AME-D06 / D10 已确认，公开可用需要 Windows ↔ macOS 双向验收。
5. 跨设备首版同时支持 Claude 和 Codex（C14，2026-10-27），双机验收两个 Agent 都要跑。这一条推翻了 `etrnal-dev` ADR 0005「Codex 首版」的范围部分。

## 后果

- 好：
  - 只有一个运行底座，D14 保持成立；
  - B2（版本写死）随之消失；
  - 以后 Codex 升级只改一处；
  - 补 Claude 等 Agent 的成本降到「adapter 已有」。
- 坏：
  - 要改造 `etrnal-dev` 的执行端，并补齐已有对话接续，粗估 L；
  - 推翻 `etrnal-dev` 第 2.3 节第 4 条（完全访问对话经本机授权后可远程接续），需要转告作者。

## 考虑过的其他方案

- 把 A-14、G4、G8 移植到 Python 路径：短期成本约 M，但两套代码要长期同步。
- 两套并存、不对齐：会重新引入 A-14 已否决的写入绕过，否决。
