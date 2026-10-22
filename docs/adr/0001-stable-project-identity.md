# 0001 项目使用稳定 ID，路径只是设备挂载

- 状态：提议
- 日期：2026-10-23
- 关联：B03、B08、B27；`docs/c0/b03-contract/README.md` §2、§6

## 背景

现有 `transcript-store.ts` 以 `sha1(realpath(cwd))` 作为 projectId。同一仓库在 Mac 和 N5095 上路径不同，ID 就不同；搬目录 ID 也会变。架构 11 要求「稳定 ID、仓库身份……路径只是设备本地映射」，跨设备派工需要两端认出同一个项目。

## 决定

1. Project 使用 `prj_<uuid v7>`，创建后不变。
2. 仓库身份 = GitHub `owner/repo` + 初始 commit；没有远端时只用初始 commit；空目录用随机 ID 并写入 `.ahastudio/project.json`（是否允许写入待产品确认）。
3. 每台设备的路径记录为 `ProjectMount {projectId, deviceId, path}`。
4. 旧 `sha1(realpath)` 保存为 `legacyIds`，读旧数据时通过它查找。

## 后果

- 好：跨设备、搬目录都不丢项目；多个检出可以归到同一项目。
- 坏：需要一次迁移；两个检出指向同一仓库时要合并，合并逻辑需要测试。
- 风险：写 `.ahastudio/project.json` 会改用户仓库（需要用户同意）。

## 考虑过的其他方案

- 继续按路径：跨设备无法识别，否决。
- 只用 GitHub `owner/repo`：fork 与 upstream 会冲突、本地仓库没有远端时无法识别，所以加上初始 commit。
