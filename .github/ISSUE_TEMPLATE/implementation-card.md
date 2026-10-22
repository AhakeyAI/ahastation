---
name: 实施卡
about: 一个可独立评审、可验收的实现单元（挂在 WBS 工作包下）
title: "[A-xx] "
labels: implementation-card
---

## WBS / 卡号
<!-- 例：B08 / A-03 -->

## 目标
<!-- 一句话 -->

## 设计依据
<!-- 文档路径 + 段落，例：docs/c0/b03-contract/README.md §6 -->

## 允许修改范围
<!-- 目录 / 文件；明确不许碰的文件 -->

## 验收
- [ ]

## 不做

## 额度与权限
<!-- 是否调用付费模型、是否写外部系统 -->

## 回退

## 完成定义（DoD）
- [ ] `npm run typecheck` 两端通过；`npm test` 通过（Windows 与 macOS 各一次）
- [ ] 新行为有确定性测试
- [ ] 验收条款逐条附证据
- [ ] 独立复核（另一人或另一 Agent 会话）
- [ ] 已合并到 main
