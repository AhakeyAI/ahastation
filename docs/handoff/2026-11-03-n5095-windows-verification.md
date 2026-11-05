# AhaStudio Windows N5095 本地验证与合并交接

2026-11-04 · Shawn（Claude 整理）。在线版：https://claude.ai/artifact/SkDmy2RxjizJyitU17eqci

在 N5095（Windows x64）上用一个安装包验证 #154 和 #155，都通过后合并 #156 到 main。这周已合入 main 的会议流程顺带在 Windows 上走一遍，此前只在 Mac 真机上验证过。

## 第三轮（11-04）：先测这一节

第二轮由 N5095 上的自动化代理跑完，没合。报告在 `docs/n5095-validation-2026-10-27` 分支的 `docs/c0/results/N5095-PR156-round2-2026-11-04.md`。复核后，真正的产品问题有两个，已在 [#158](https://github.com/AhakeyAI/ahastation/pull/158) 修好，并合进了验证分支。其余失败大多是测法问题，语音相关的几项这一轮要人在 N5095 上手动测。

**前两轮结果**

| 结果 | 编号 | 原因和这一轮怎么处理 |
| --- | --- | --- |
| 通过 | B1、B2、M1、M5、V4、O1 | 第一轮通过，不用重测 |
| 基本通过 | D1 | 第二轮 Host 第一次就写对了字段，生成了 `.md` 和 `.ics`，开始时间和提前 15 分钟提醒都对。只差有人看一眼默认日历的导入弹窗 |
| 不挡合并 | M2、M4、M6 | main 上同样失败，单独开 issue |
| 失败，已修 | C1–C4 | 信任提示已经过去（#157 生效），但 Codex Worker 两次都在启动约 20 秒后崩溃，应是被 Codex 启动时的更新菜单挡住。#158 关掉了 Worker 的更新检查；菜单仍出现时，也等处理完再粘贴任务 |
| 失败，已修 | C1 第二次 | Codex Host 对用户说「已经派出 Worker」，又转述了「Worker」的结论，实际没发命令，也没有 Worker。#158 让它在这种情况下收到更正提示 |
| 测法不成立 | P1、P2、V1、V2 | V2 播放测试句时麦克风还是静音状态；P1 改的是注册表，没走设置里的开关；V1 采样时机器在装依赖 |
| 没测 | V3、F1 | 自动化切不到后台；CPU 采样被并行任务干扰 |

**准备**

1. 拿新代码：`git fetch origin` 后 `git checkout verify/n5095-2026-11-03`，再 `git pull`。git log 里要有 #158 的合并提交 `230eeca`，`npm ci` 后可以从源码启动。
2. 或者用新安装包：`gh run download 41803899005 -R AhakeyAI/ahastation -n pkg-windows-latest`。CI 打完才能下载，[打包进度](https://github.com/AhakeyAI/ahastation/actions/runs/41803899005)。
3. 讯飞 ASR 凭据同上一轮（Shawn 单独发），不要写进仓库、截图或日志。
4. 第二轮恢复麦克风隐私设置的命令报过错。先到 设置 → 隐私和安全性 → 麦克风，确认「允许桌面应用访问麦克风」是打开的。
5. 把布局固定成桌面：打开设置，在显示版本号的那一页把「掌机模式」从「自动」改成「桌面」。N5095 是触屏、屏幕窄，「自动」会切到掌机布局（底部工具栏、单列项目室），和 Mac 不一样；清单按桌面布局写。测完再改回「自动」。

**第三轮清单**

T1–T5 可以用自动化跑，T6–T8 要人来测。截图要截 AhaStudio 窗口；采样 CPU 时不要同时跑安装或构建。

| 编号 | 操作 | 通过标准 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| T1（C1） | 会议里说：「帮我用鼠标打开记事本，输入：你好 AhaStudio」 | 任务看板出现这个任务；Worker 标签里不再出现 Codex 更新菜单；记事本打开，内容正好是「你好 AhaStudio」 | 未测 | 出现信任提示时，在那个终端里选 1 并回车。Host 说已派出但看板上没有任务，记为失败 |
| T2（C2） | 系统缩放 125% 和 100% 各做一次 T1 | 两种缩放下点击位置都不偏 | 未测 |  |
| T3（C3） | 让 Worker 在记事本里按 cmd+a、cmd+c | 实际触发 Ctrl+A、Ctrl+C | 未测 |  |
| T4（C4） | 让 Worker 在一个长网页上向下滚动 3 格 | 方向向下，幅度正常 | 未测 |  |
| T5（D1） | 双击 `文档\AhaStation\decisions` 里第二轮生成的 `.ics`，或让助理再出一份决策单 | 默认日历弹出导入，开始时间是截止时间，提前 15 分钟提醒 | 未测 |  |
| T6（P1、P2） | 在 设置 → 隐私和安全性 → 麦克风 里手动关掉「允许桌面应用访问麦克风」，按原清单做 P1；再打开，做 P2 | 同原清单 | 未测 | 不要改注册表 |
| T7（V1、V2） | 确认麦克风按钮显示「静音」（也就是已开麦）后，对着麦克风说一句话；再点静音，等 30 秒看任务管理器 | 说的话被识别并发给助理；静音时 AhaStudio 各进程 CPU 接近 0，任务栏的麦克风图标消失 | 未测 |  |
| T8（V3、F1） | 按原清单做 V3（用 DevTools 看 `document.documentElement.dataset.windowActive`），再填 F1 表 | V3 同原清单；静音时 CPU 明显低于开麦时 | 未测 | 第二轮 GPU 进程在静音和开麦时都在 20% 左右，记下这一轮的数值 |

合并条件：T1–T5 通过；T6–T8 通过，或写明跳过的原因。M2、M4、M6 不挡合并。第一轮的 21 项清单在后面，操作和通过标准都沿用。

## 验证范围

验证分支 `verify/n5095-2026-11-03` = main（86a1466）+ #154 + #155，加上验证中修的 91476cd、#157、#158，对应 PR #156，拉这个分支就能拿到代码和本说明，验证通过后直接合并它。

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

第一轮清单，结果见「第三轮」一节。共 21 项，按顺序做：前面的步骤会为后面准备好会议。每项做完在「结果」列选通过或失败，失败的在「备注」写现象。

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

1. 第三轮清单满足合并条件（见「第三轮」一节）；第一轮已通过的项不用重测。「失败」的先在验证分支上修，重新打包再测。
   - #154 的部分：B2、C1–C4、D1、P1–P2。
   - #155 的部分：V1–V4、O1，F1 里静音时 CPU 明显低于打开时。
2. 确认 #156 的 CI 三个平台都是绿的。如果失败的是下面的已知偶发测试，只重跑失败项：`gh run rerun <run id> -R AhakeyAI/ahastation --failed`。如果是别的测试，不要合。
3. 合并：`gh pr merge 156 -R AhakeyAI/ahastation --merge`（合并提交，不要 squash，否则 #154、#155 不会自动标为已合并）。
4. 确认 #154、#155、#157、#158 已显示为 Merged；没有的话手动关闭，并留言「已随 #156 合入」。
5. 在 main 上打新安装包：`gh workflow run build-matrix.yml -R AhakeyAI/ahastation --ref main`。只生成 30 天的构建产物，不发 Release。

**已知的偶发失败测试**（和改动无关，只改文档的 PR 也会失败）

| 平台 | 测试 |
| --- | --- |
| ubuntu-latest | `station-process-recovery`：Restart must prove old fixture process exit，或 receiver process crash restores original device… |
| windows-latest | `H02/H08 production WSS: suspended stop retains its input…` |
| windows-latest | `Windows startup failure is session-local and persistence recovers after a failed write` |
| windows-latest | `two production Station receivers share real Hub state, persist receipt, execute once, stop and explicitly continue` |
| macos-latest | `F3 actual React identical refresh preserves the exact baseline edit` |
| windows-latest | `S05 actual attachment preparation failure preserves new edits and cannot generate a message` |

## 已知限制和不在这次范围内的

下面这些在 N5095 上看到属于预期，不算验证失败。

- **启动台和看板里的外部 Claude/Codex 会话**：Windows 上可能不显示。Windows 和 Linux 的实现由 Dryoung95 在 [#145](https://github.com/AhakeyAI/ahastation/pull/145) 里做，这次不测。
- **语音引导弹窗**：只在 Mac 上出现。#154 已经支持在 Windows 上打开 `ms-settings:speech`，但界面上还没有入口，要先确认 Windows 有哪些中文语音再写步骤。
- **Station 接 Codex 任务**：Windows 需要安装包里带 `station-native.exe`。CI 打包时会构建它，但这份清单没有单独检查。
- **安装包没有签名**：SmartScreen 会拦。
- **Ubuntu 真机**：还没安排。Ubuntu 用 Wayland 桌面时，Computer Use 只能操作 X11 兼容层（XWayland）里的窗口。
- **Mac 上的改变**：Computer Use 的三击现在是连续三次单击，可能不被当成三击；决策写入日历会多一次「添加到日历」确认。这两项不影响 N5095 的验证。
- **libnut 底层脚本**：第一轮的 `pr156-computer-use-primitives.mjs` 停在脚本自己激活窗口的那一步（`Could not activate PID 10424`），libnut 没被调用。以 T1–T4 的 Worker 实测结果为准，脚本修好后可以再补跑。
- **空仓库里的代码交付**：91476cd 让没有提交的仓库也能开会，但改代码的任务在定稿提交时会停住，等你手动退回；只读和只交报告的任务不受影响。这次不测，另开 PR 处理。
- **Host 虚报派工的检测**：#158 按 Host 的说法匹配（「已经派出 Worker」「Worker 已确认」这类话），只在前后 10 分钟内没有任何 Worker 活动时提醒 Host 更正。会议里已经有 Worker 在跑时，这类虚报发现不了。
