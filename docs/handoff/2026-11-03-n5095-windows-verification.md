# AhaStudio Windows N5095 本地验证与合并交接

2026-11-03 · Shawn（Claude 整理）。在线版：https://claude.ai/artifact/SkDmy2RxjizJyitU17eqci

在 N5095（Windows x64）上用一个安装包验证 #154 和 #155，都通过后合并 #156 到 main。这周已合入 main 的会议流程顺带在 Windows 上走一遍，此前只在 Mac 真机上验证过。

## 验证范围

验证分支 `verify/n5095-2026-11-03` = main（86a1466）+ #154 + #155，对应 PR #156，拉这个分支就能拿到代码和本说明，验证通过后直接合并它。

| 内容 | 来源 | Windows 上此前的状态 |
| --- | --- | --- |
| Computer Use 三端统一（libnut）、决策日历改 `.ics`、Windows 麦克风权限与诊断 | [#154](https://github.com/AhakeyAI/ahastation/pull/154)（e93d9c2） | Computer Use 不可用；日历、提醒不可用；麦克风一律当作已授权 |
| 静音停掉语音检测、音量条限帧、后台暂停动画、去掉常驻毛玻璃、退出时关掉 opencode | [#155](https://github.com/AhakeyAI/ahastation/pull/155)（32fff67） | 只在 Mac 上测过；opencode 在 Windows 上退出后一定残留 |
| 项目室、开场流程、退出后带回、关闭会议不带回、重新开始替换标签 | 已在 main（#144 等） | 只跑过 CI 单元测试，没上过 Windows 真机 |

注意：Windows 上关闭主窗口就是退出应用，所以「退出后带回」在 Windows 上由关窗触发。

## 准备

优先用 CI 打好的安装包；想看控制台日志或改代码时再从源码启动。

**A. 安装包（推荐）**

1. 等 [CI 运行 41658249043](https://github.com/AhakeyAI/ahastation/actions/runs/41658249043) 的 windows-latest 变绿。如果挂在已知的偶发测试上（见「合并」一节），只重跑 Windows 这一项。
2. 在 N5095 的 PowerShell 里下载：`gh run download 41658249043 -R AhakeyAI/ahastation -n pkg-windows-latest`，得到 `AhaStudio Setup 0.19.0-integration.1.exe`。
3. 安装前从托盘图标选「退出 AhaStudio」，确认任务管理器里没有 AhaStudio 进程。
4. 先记下残留的 opencode：`Get-Process opencode -ErrorAction SilentlyContinue`。旧版留下的可以先 `Stop-Process -Name opencode` 清掉，后面验证「退出不残留」时才有干净的起点。
5. 备份会议数据（可选）：复制 `%APPDATA%\ahastation\meetings`。这次改动不迁移数据，只是以防万一。
6. 运行安装包。包没有签名，SmartScreen 拦截时点「更多信息 → 仍要运行」。版本号和之前一样，会直接覆盖安装。

**B. 从源码启动**

1. `git fetch origin` 后 `git checkout verify/n5095-2026-11-03`。
2. `npm ci`：#154 新增了 `@nut-tree-fork/libnut-*` 依赖，必须重新安装。
3. 双击仓库根目录的 `Start-AhaStation.cmd`，它会自己构建并启动。

**验证前都要准备好**

- Claude Code 或 Codex 至少登录一个，用来跑开场和 Computer Use。
- 打开任务管理器的「详细信息」页，按 CPU 排序，性能对比要用。
- 系统缩放记下当前值（设置 → 系统 → 屏幕 → 缩放），Computer Use 要在 100% 和 125%/150% 各测一次。

## 验证清单

共 21 项，按顺序做：前面的步骤会为后面准备好会议。每项做完在「结果」列选通过或失败，失败的在「备注」写现象。

| 编号 | 操作 | 通过标准 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| B1 | 启动 AhaStudio | 主窗口出现，托盘有图标，没有报错弹窗 | 未测 |  |
| B2 | 启动台点「设备就绪」 | 麦克风一行显示「已授权」或「被拒绝」，不再是「进入会议后测试」（#154） | 未测 |  |
| M1 | 新建项目室 → 打开本机文件夹，选一个空的 git 仓库 | 启动台出现这个项目室，路径是 `C:\…` 格式 | 未测 |  |
| M2 | 进入会议，开场选「讨论脑暴」→「开始」 | 「产品专家 小禾」入会；舞台出现「子 Agent · 小禾」标签；工作区有纪要 | 未测 |  |
| M3 | 子 Agent 第一次出现 Claude「信任此文件夹」时 | 标签里有「信任这个工作树并继续」按钮，点了能继续 | 未测 |  |
| M4 | 关掉主窗口（等于退出），重新打开，在这个项目室点「继续会议」 | 小禾回来；没做完的子 Agent 显示「已停止」；纪要还在 | 未测 |  |
| M5 | 在已停止的子 Agent 标签点「重新开始」 | 旧标签被替换，只剩一个子 Agent 标签 | 未测 |  |
| M6 | 关闭会议标签，再从启动台进同一个项目室 | 从空白开始：没有专家、没有纪要、没有空着的子 Agent 标签 | 未测 |  |
| C1 | 在会议里说：「帮我用鼠标打开记事本，输入：你好 AhaStudio」 | 派出 Computer Use Worker；能截图、点开记事本、中文输入正确（#154） | 未测 | 说法里要有「鼠标」或「点击」才会派 Computer Use |
| C2 | 把系统缩放改到 125% 或 150%，重复 C1 | 点击位置不偏 | 未测 | 截图像素直接当作物理像素，这项最可能出问题 |
| C3 | 让 Worker 在记事本里按 cmd+a、cmd+c | 实际触发 Ctrl+A、Ctrl+C（全选、复制） | 未测 |  |
| C4 | 让 Worker 在一个长网页上向下滚动 3 格 | 方向向下，幅度正常 | 未测 |  |
| D1 | 对助理说：「这两个方案我拿不准，用决策单让我选」 | `文档\AhaStation\decisions` 下生成 `.md` 和 `.ics`；默认日历（Outlook 或 日历）弹出导入；时间是截止时间，提前 15 分钟提醒（#154） | 未测 |  |
| P1 | 设置 → 隐私和安全性 → 麦克风，关掉「允许桌面应用访问麦克风」，回会议开麦克风 | 弹出「需要麦克风权限」，点「打开系统设置」跳到麦克风隐私页（#154） | 未测 |  |
| P2 | 重新打开那个开关，回会议再开麦克风 | 能正常聆听 | 未测 |  |
| V1 | 会议进行中点麦克风静音，等 10 秒 | 任务管理器里 AhaStudio 各进程 CPU 接近 0；任务栏的麦克风使用图标消失（#155） | 未测 |  |
| V2 | 取消静音，说一句话 | 正常识别并发给助理 | 未测 |  |
| V3 | 子 Agent 运行时把窗口切到后台，过一会儿再切回来 | 后台时状态点、转圈停住；切回前台继续动（#155） | 未测 |  |
| V4 | 深色模式下看会议界面 | 顶栏、工具栏、标签栏、卡片没有毛玻璃，文字清楚，布局正常 | 未测 |  |
| O1 | 打开一个用 OpenCode 的会话或 OpenCode 编辑器，确认任务管理器里有 opencode.exe，然后关窗退出 | 退出后 `Get-Process opencode` 没有结果（#155） | 未测 | 之前 Windows 上退出后一定残留 |
| F1 | 同一个会议、窗口在前台：静音和不静音各看 30 秒 | 把下表填上 | 未测 |  |

**F1 性能记录（N5095）**

| 场景 | AhaStudio 主进程 CPU % | 渲染进程 CPU % | GPU 进程 CPU % | 整机 CPU % |
| --- | --- | --- | --- | --- |
| 没开会议（启动台） |  |  |  |  |
| 会议中，麦克风静音 |  |  |  |  |
| 会议中，麦克风打开 |  |  |  |  |
| 会议中，子 Agent 在运行 |  |  |  |  |

## 出问题时

失败的项目回报到对应 PR 的评论里：B2、C、D、P 开头的回报到 #154，V、O、F 开头的回报到 #155，M 开头的是 main 上已有的功能，单独开 Issue。

**每项失败带上**

- 编号、做了什么、看到了什么、截图（性能问题附任务管理器截图）。
- 系统缩放比例、是否深色模式、用的是安装包还是源码启动。
- 下面对应的日志或文件。发出前看一眼，确认没有 API Key、Token 或配对码。

| 要找的 | 位置 |
| --- | --- |
| 安装包启动的日志 | Electron 日志目录，一般是 `%APPDATA%\ahastation\logs`；取不到时回退到 `%TEMP%\AhaStation-lifecycle` |
| 源码启动的日志 | `%TEMP%\AhaStation-launch\<时间>-<PID>` 里的 `launcher.log` 和 `lifecycle.jsonl`，保留最新两份 |
| 会议快照（M4、M6） | `%APPDATA%\ahastation\meetings\<会议 id>\snapshot.json`；看 `endedBy`：关窗退出应为 `app-quit`，关会议标签应为 `user` |
| 决策文件（D1） | `%USERPROFILE%\Documents\AhaStation\decisions`，同名的 `.md` 和 `.ics` |
| 残留进程（O1） | `Get-Process opencode \| Format-List Id,StartTime,Path` |

**要看界面报错**：安装包默认不开开发者工具。在 PowerShell 里先 `$env:VIBE_MEET_DEVTOOLS=1`，再从同一个窗口启动 AhaStudio.exe，然后按 Ctrl+Shift+I，把 Console 里的红色报错截图。

## 验证通过后合并

验证通过后只合并 [#156](https://github.com/AhakeyAI/ahastation/pull/156)（验证分支本身）。它包含 #154 和 #155 的提交，用合并提交合入后，GitHub 会自动把 #154、#155 标为已合并。也可以把清单结果发给 Claude，由它按下面的步骤合并。

1. 清单里的项全部「通过」或「跳过」；「失败」的先在验证分支上修，重新打包再测。
   - #154 的部分：B2、C1–C4、D1、P1–P2。
   - #155 的部分：V1–V4、O1，F1 里静音时 CPU 明显低于打开时。
2. 确认 #156 的 CI 三个平台都是绿的。如果失败的是下面的已知偶发测试，只重跑失败项：`gh run rerun <run id> -R AhakeyAI/ahastation --failed`。如果是别的测试，不要合。
3. 合并：`gh pr merge 156 -R AhakeyAI/ahastation --merge`（合并提交，不要 squash，否则 #154、#155 不会自动标为已合并）。
4. 确认 #154、#155 已显示为 Merged；没有的话手动关闭，并留言「已随 #156 合入」。
5. 在 main 上打新安装包：`gh workflow run build-matrix.yml -R AhakeyAI/ahastation --ref main`。只生成 30 天的构建产物，不发 Release。

**已知的偶发失败测试**（和改动无关，只改文档的 PR 也会失败）

| 平台 | 测试 |
| --- | --- |
| ubuntu-latest | `station-process-recovery`：Restart must prove old fixture process exit |
| windows-latest | `H02/H08 production WSS: suspended stop retains its input…` |
| windows-latest | `Windows startup failure is session-local and persistence recovers after a failed write` |

## 已知限制和不在这次范围内的

下面这些在 N5095 上看到属于预期，不算验证失败。

- **启动台和看板里的外部 Claude/Codex 会话**：Windows 上可能不显示。Windows 和 Linux 的实现由 Dryoung95 在 [#145](https://github.com/AhakeyAI/ahastation/pull/145) 里做，这次不测。
- **语音引导弹窗**：只在 Mac 上出现。#154 已经支持在 Windows 上打开 `ms-settings:speech`，但界面上还没有入口，要先确认 Windows 有哪些中文语音再写步骤。
- **Station 接 Codex 任务**：Windows 需要安装包里带 `station-native.exe`。CI 打包时会构建它，但这份清单没有单独检查。
- **安装包没有签名**：SmartScreen 会拦。
- **Ubuntu 真机**：还没安排。Ubuntu 用 Wayland 桌面时，Computer Use 只能操作 X11 兼容层（XWayland）里的窗口。
- **Mac 上的改变**：Computer Use 的三击现在是连续三次单击，可能不被当成三击；决策写入日历会多一次「添加到日历」确认。这两项不影响 N5095 的验证。
