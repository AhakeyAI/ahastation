# 0004 运行底座：保留现有 adapter，不引入 Paseo 作为执行层

- 状态：已接受（2026-10-23，用户确认 D14）
- 日期：2026-10-23
- 关联：B04、B10、B28、X5；证据 `docs/c0/b04-runtime/README.md`「完整矩阵」与 `docs/c0/b04-runtime/results/`

## 背景

WBS 要求 C0 选定单一运行底座。候选：现有 AhaStation adapter（C-A）与 Paseo 0.12.0 daemon + 公开 SDK（C-P）。2026-10-23 在 N5095 / Windows 11 上用同一任务、同一权限代理跑了 S1–S10 × Claude / Codex（用户已授权额度）。

## 决定

1. 保留 C-A 为唯一运行底座。
2. 不使用 Paseo 作为本机执行层，也不使用 Paseo connected hosts 作为跨设备远端执行面；跨设备传输按 `remote-control.md` 方案 A 自建。
3. 借鉴 Paseo 的三项设计并自行实现：任务在独立后台进程运行、宿主重启不丢；断线期间待批准请求保留在执行端；订阅窗口读取。

## 依据

- C-P × Codex 在一票否决项 S4 失败：Paseo 的 Codex 最严格模式是 `auto`（`on-request` + `workspace-write`），工作区内写入不经宿主，宿主无法按目录授权。Codex 0.156.1 已不支持 `approval_policy = "untrusted"`，无法通过 provider 选项补回。
- C-P × Codex S7 失败（重连后时间线为空）。
- C-P 的优势（S8 宿主重启不丢、S9 用量）可以在 C-A 上自行实现，不需要接受授权语义上的倒退。
- C-A × Claude 全部通过；C-A2 × Codex（仅放开版本门）通过全部否决项。

## 后果

- 好：授权模型保持在宿主手中；不引入快速迭代的外部依赖（Paseo 两周 4 个预发布）。
- 坏：B10/B30 的「后台独立运行」、B06 的用量读取都要自己做；跨设备传输 XL 规模不变。
- 必须先修：A-14（Codex 固定版本已不可用，且 `untrusted` 被弃用，需要重新设计 Codex 授权映射）、A-15（Claude 默认模型失效）、A-16（Codex 写入批准缺路径）、A-17（用户级 hooks 绕过宿主授权）、A-18（Claude 就绪超时）、A-19（中断双终止信号）、A-20（停止后已批准命令仍执行）。

## 考虑过的其他方案

- 采用 Paseo 仅用于 Claude：两种 provider 走两套底座，违反「单一运行底座」，且 C-P × Claude 的 S2 追问会丢原任务。
- 采用 Paseo 并自己补授权：需要改 Paseo 的 provider 代码（fork），失去引入它的意义。
