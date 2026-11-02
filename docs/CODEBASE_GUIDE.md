# AhaStation 文件夹与代码文件职责索引

AhaStation 是一个语音会议式 AI 编程协作桌面客户端。React 界面负责展示和交互，Electron 主进程负责会议、模型会话、任务执行、文件访问和系统能力。多个编程 Agent 通过统一后端接口加入会议，任务结果经过验证、审查和集成，最终由用户验收。

本文对应 2026 年 10 月 13 日的当前工作树，包含尚未提交的 Pocket Vibe 和公网远端控制实现。表格中的文件名相对于所在小节的目录；可以用编辑器搜索文件名，或通过文末的功能定位表查入口。

范围包括所有自有源码、测试代码、脚本、项目配置，以及文档和静态资源。第三方依赖、编译后的副本和 Git 内部文件按目录说明，不逐个展开。统计不计本文：electron 有 160 个文件，src 有 145 个文件，scripts 有 16 个文件，tests 有 136 个文件，其中 118 个是自动化测试文件。

## 先理解整体调用关系

~~~mermaid
flowchart TD
  UI["src 界面组件和 Hooks"] --> Store["src/lib/meeting-store.ts 界面状态"]
  UI --> Bridge["electron/preload*.cjs 白名单桥"]
  Bridge --> IPC["electron/ipc 按领域接收请求"]
  IPC --> Sessions["sessions.ts 多项目会议注册表"]
  Sessions --> Orch["orchestrator.ts 会议编排"]
  Orch --> Host["host-group.ts 主持人和员工组"]
  Host --> Scheduler["worker-scheduler.ts 任务调度"]
  Host --> Backend["backends 统一 Agent 接口"]
  Scheduler --> Backend
  Scheduler --> Delivery["delivery 与 coordinator-review 验证审查集成"]
  Delivery --> Final["meeting-delivery.ts 最终会议交付"]
  Backend --> Events["事件和持久化记录"]
  Events --> Store
  Backend --> Local["本机 CLI SDK 服务或交互终端"]
  Backend --> Remote["Pocket Vibe HTTP Hub 远端会话"]
~~~

几个术语：Talker 是和用户对话的会议 Agent；Coordinator 是负责规划与审查的协调角色；Worker 是执行具体任务的 Agent。Backend 是对 Claude、Codex 等客户端的适配。IPC 是界面与 Electron 主进程之间的通信。PTY 是能够运行真实交互式终端程序的伪终端。MCP 是向 Agent 提供工具的协议。

## 目录总览

| 目录 | 作用 |
| --- | --- |
| src/ | React 渲染进程：用户界面、状态、语音采集和播放。 |
| src/components/ | 页面、面板、按钮、卡片和弹窗。 |
| src/hooks/ | 把状态订阅、IPC 和有生命周期的行为封装成 React Hook。 |
| src/lib/ | 界面状态仓库、事件处理和不依赖具体组件的逻辑。 |
| src/lib/companion/ | 陪伴屏的游戏画面和提示音。 |
| src/assets/cli-icons/ | 被 Vite 打包进界面的客户端图标。 |
| src/skills/ | 项目附带的 Agent 技能说明，两个子目录分别放技能入口和正文。 |
| electron/ | Electron 主进程和预加载桥；应用的系统能力及核心业务。 |
| electron/backends/ | 各种 Agent 后端、传输协议、能力检测和执行配置。 |
| electron/claude-cli/ | 直接驱动 Claude CLI 的协议实现。 |
| electron/ipc/ | 按业务领域拆分的主进程通信处理器。 |
| electron/asr/ | 讯飞实时语音识别客户端及音频转换。 |
| electron/attachments/ | 附件解析、保存及资源引用。 |
| electron/ide/ | 编辑器接口、注册表、窗口和迁移状态。 |
| electron/ide/opencode/ | OpenCode 编辑器接入与共享服务管理。 |
| electron/observe/ | 发现和观察外部启动的 AI 会话，推断运行状态。 |
| electron/observe/process/ | 当前实现的 macOS 进程扫描器。 |
| electron/observe/statefiles/ | 各客户端本地状态文件的读取器。 |
| electron/companion/ | 陪伴屏的状态模型、事件推送和窗口管理。 |
| tests/ | 自动化回归测试及 Electron 模拟模块。 |
| tests/fixtures/ | 测试使用的固定样例数据。 |
| tests/fixtures/observe/ | 观察层的模拟进程、文件句柄和用户目录。 |
| scripts/ | 开发启动、资源准备、打包检查和真实环境烟测。 |
| scripts/board/ | RK3588 板端验收脚本和版本基线。 |
| scripts/lib/ | 构建脚本共享的缓存工具。 |
| public/ | 原样复制到前端产物的静态资源。 |
| public/vad/ | 语音活动检测模型、AudioWorklet 和 ONNX 浏览器运行时。 |
| public/voice-id/ | 声纹识别模型。 |
| resources/ | Electron 打包时额外携带的运行配置。 |
| build/ | 安装包图标、macOS 权限声明等打包素材；不是前端编译输出。 |
| cliicon/ | 客户端原始图标素材；界面导入的是 src/assets/cli-icons。 |
| docs/ | 技术方案、交接说明、调查与验收记录。 |
| docs/adr/ | 重要架构决策。 |
| docs/plans/ | 特定功能的详细设计与实施计划。 |
| docs/research/ | 客户端协议、设备和平台支持调查。 |
| .github/workflows/ | GitHub Actions 持续集成和跨平台构建。 |
| node_modules/ | npm 安装的第三方依赖，包括 Electron 和平台相关原生二进制。 |
| dist/ | Vite 生成的前端 HTML、CSS、JS 和静态资源。 |
| dist-electron/ | TypeScript 编译后的主进程代码，以及复制过去的预加载文件。 |
| release/ | 打包流程生成的安装包及解包目录；当前顶层未出现，配置中指定此输出目录。 |
| .git/ | Git 的提交、分支、索引和对象数据库。 |

## 根目录配置与入口

| 文件 | 做什么 |
| --- | --- |
| package.json | 定义项目版本、依赖、开发启动、两端类型检查、测试和各平台打包命令；Electron 入口指向 dist-electron/main.js。 |
| package-lock.json | 锁定 npm 依赖的实际版本和依赖树，保证安装可复现。 |
| index.html | 前端 HTML 外壳，提供 React 挂载节点并加载 src/main.tsx。 |
| vite.config.ts | 配置 React 构建、开发服务 5173 端口、dist 输出与第三方依赖分块。 |
| tsconfig.json | src 渲染进程的 TypeScript、DOM 和 JSX 配置；只检查，不输出 JS。 |
| tsconfig.electron.json | Electron 主进程 TypeScript 配置，将 electron 下的 TS 编译到 dist-electron。 |
| electron-builder.json | 指定安装包格式、图标、额外资源、需要从 asar 解包的原生二进制以及平台权限。 |
| .gitignore | 排除依赖、编译产物、发布包、缓存，以及应用生成的项目资料目录。 |
| .npmrc | 指定 npm 官方包源。 |
| README.md | 项目定位、功能、运行方式和架构介绍。 |
| AGENTS.md | Codex 的仓库工作约束，包含保护未提交改动及构建检查要求。 |
| CLAUDE.md | Claude 使用的对应仓库工作说明。 |

## Electron 启动与系统基础

下表文件均在 electron/。这一层把窗口、系统权限、持久化和业务模块组装起来。

| 文件 | 做什么 |
| --- | --- |
| main.ts | 主进程入口：创建主窗口、注册应用资源协议和 IPC、初始化会话及观察服务、处理单实例、窗口生命周期、GPU 故障和退出收尾。 |
| preload.cjs | 向主界面暴露 window.vibeMeet 白名单 API，把调用转换成 IPC，并把主进程事件交给界面。 |
| preload-editor.cjs | 独立编辑器的受限桥：文件浏览与写入、编辑器 PTY、编辑器状态事件。文件顶部“只读”注释早于现有 write API。 |
| preload-companion.cjs | 陪伴屏与 AhaBar 的受限桥：状态、音效偏好、审批操作、主窗口聚焦和恢复命令复制。 |
| sessions.ts | SessionRegistry：按项目目录维护会议槽位、激活标签和顺序，每个槽位拥有一个 Orchestrator。 |
| store.ts | 用户设置的 JSON 持久化，包含后端配置、最近项目、打开标签、声音偏好和远端身份；串行原子写入，处理凭证加密。 |
| settings-loader.ts | 读取 Claude 设置并构建经过白名单过滤的子进程环境。 |
| claude-defaults.ts | 生成 Claude 的影子配置目录，把随应用附带的默认技能等与用户配置合并。 |
| renderer-security.ts | 生成 CSP 和跨源隔离响应头，校验应用资源协议路径，提供窗口背景颜色。 |
| diagnostic-logger.ts | 将诊断信息写入日志。 |
| format-error.ts | 格式化错误，并过滤密钥、Bearer Token 等敏感文本。 |
| normalize-base-url.ts | 去除模型服务地址的首尾空格和尾部斜线。 |
| microphone-access.ts | macOS 麦克风授权与拒绝后的系统设置引导，合并并发授权请求。 |
| handheld-mode.ts | 根据用户覆盖设置、触摸指针和屏幕宽度判断桌面或掌机模式。 |
| display-migration.ts | 计算外接屏变化时，编辑器 overlay 与独立窗口之间的迁移动作。 |
| minimize-prompt.ts | 决定最小化或关闭主窗口时是否提示切换 AhaBar，并映射用户选择。 |
| dir-list.ts | 给应用内目录选择器列出子目录，处理隐藏项和排序。 |
| update-check.ts | 检查并缓存 GitHub 最新发布版本，提供版本比较；本文件不执行安装更新。 |
| pty-host.ts | 管理真实 CLI 和 shell 的 PTY 进程、输入、尺寸、退出和输出环形缓冲。 |
| browser-tab-manager.ts | 管理内嵌浏览器 WebContentsView 的标签、导航、可见性、位置和页面操作。 |
| browser-mcp.ts | 把内嵌浏览器的导航、点击、输入、截图等封装为 Worker 可调用的 MCP 工具。 |
| computer-use.ts | macOS 桌面自动化底层：截图、鼠标、键盘、滚动及辅助功能权限检查。 |
| computer-use-mcp.ts | 把桌面自动化封装成 Agent 的 MCP 工具，向会话注入截图。 |
| remote-control-types.ts | 公网远端控制的设置、设备、任务和界面响应类型。 |
| remote-control.ts | 独立管理远端所有者身份、配对、服务请求和待完成提交引用，注册远端控制 IPC。 |

## Electron 会议编排与记录

| 文件 | 做什么 |
| --- | --- |
| orchestrator.ts | 一场会议的总协调器：主持人组、用户消息、计划和命令执行、任务协作、远端成员、审批、审查、最终交付及结束流程。 |
| host-group.ts | 封装一个 Host 会话和对应 WorkerScheduler；多后端主持人可以属于不同组。 |
| worker-scheduler.ts | 管理 Worker 池、任务依赖图、并发和优先级、工作区、消息、权限、返工、交付审查及生命周期清理。 |
| worker-backend-default.ts | 当任务未指定执行后端时，按用户设置和可用性选择默认 Worker，优先使用适用的交互终端后端。 |
| orchestrator-types.ts | 主进程编排事件、计划、Worker 状态和 Host 等共享类型。部分结构需要与 src/types.ts 保持一致。 |
| orchestrator-prompts.ts | Talker、Coordinator 审查、专家、Worker 和会后总结的提示词，以及可移植 meeting-command 协议提示。 |
| orchestrator-helpers.ts | 无状态辅助逻辑：提取消息和工具调用、摘要、角色推断，以及冲突与上下文上限常量。 |
| cross-host-bus.ts | 会议内多个 HostGroup 之间的发布订阅消息总线。 |
| claude-session.ts | 直接驱动 Claude CLI 会话：启动握手、流式事件、优先级输入队列、权限请求、打断和会话快照。 |
| meeting-tool-names.ts | 会议工具名称的轻量公共词表，界面可导入而无需引入主进程文件系统逻辑。 |
| meeting-tools.ts | 会议工具输入 schema、计划及任务的规范化和校验。 |
| meeting-command.ts | 类型化会议命令及角色授权，包含计划修订；区分 Coordinator 命令与用户最终交付决策。 |
| meeting-mcp.ts | 创建 Talker 和 Worker 的 MCP 工具，包括派任务、沟通、决策、记忆和审查工具门禁。 |
| meeting-repository.ts | 会议快照与事件日志的持久化，保证事件顺序、恢复和写入可靠性。 |
| memory.ts | 按项目隔离的长期记忆，支持增删改查、相关性筛选、提示词格式化和敏感内容过滤。 |
| recap.ts | 会议结束后从对话提炼记忆，通过同一记忆存储校验后保存；支持中止。 |
| transcript-store.ts | 按项目保存与加载对话 JSONL，串行追加并限制历史长度。 |
| materials.ts | 将聊天、附件和截图存到项目 .vibe-materials，维护可读索引。 |
| decisions.ts | 创建用户决策文档、监听用户填写结论，并实现相应提醒和决策恢复流程。 |
| skills.ts | 扫描、安装和卸载 SKILL.md 技能，识别用户技能及影子目录中的内置技能。 |

## Electron 任务领域与权限

| 文件 | 做什么 |
| --- | --- |
| task-collaboration.ts | 任务协作领域的 schema：执行配置、上下文、授权、消息、工作区、执行尝试和状态。 |
| task-intent.ts | 从任务文字推断读写、命令等意图，结合项目标记补默认执行配置和依赖门槛。 |
| task-context.ts | 编译 Worker 可见的上下文包，对引用做授权校验，冻结内容并计算完整性哈希。 |
| task-authority.ts | 把已批准计划编译成绑定任务与执行尝试的授权，检查路径、命令和其他执行边界，管理追加授权。 |
| task-budget.ts | 任务预算 schema、执行消耗评估和重复失败指纹；默认预算为无限制，显式预算可触发暂停。 |
| task-workspace.ts | 选择只读、Git worktree 或共享加锁工作区，检查脏基线、写路径和冲突锁。 |
| task-mailbox.ts | 持久化任务消息队列，区分入队、送达和确认，处理顺序与重复消息。 |
| task-projection.ts | 从持久化事件重建任务视图，识别重复、过期及非法状态迁移。 |
| task-recovery.ts | 判断中断任务可以怎样恢复，规范化历史状态，避免把旧完成状态误认成已验收。 |
| worker-protocol.ts | 跨后端 Worker 信号、验收标准、WorkReport 和返工协议；解析报告围栏并限制工具输出长度。 |
| auto-approve-policy.ts | 主进程的工具风险分类和自动批准范围，区分安全工具与需要用户确认的操作。 |
| permission-broker.ts | 统一各后端权限请求，结合任务授权、自动批准、原生确认、界面审批和超时做决策。 |
| approval-gesture.ts | 将待审批请求映射成单击、按住或进入详情的交互，供 AhaBar 和虚拟键盘使用。 |

## Electron 验证审查与交付

“Agent 说完成”会进入交付流水线；任务审查通过并进入会议集成分支，与最终发布到用户工作区，是两个不同阶段。

| 文件 | 做什么 |
| --- | --- |
| delivery-harness.ts | 交付流程状态机，管理提案、工作单、报告、验证、审查、候选与验收状态。 |
| delivery-snapshot.ts | 对交付文件做快照与哈希，拒绝越界路径，限制可预览文件大小。 |
| delivery-candidate.ts | 从声明的交付路径冻结 Git 候选，检查漏报和无变化路径，支持返工重新打开候选。 |
| delivery-diff.ts | 生成候选的逐文件 diff 清单和审查块，记录证据种类。 |
| delivery-verifier.ts | 用批准的精确 argv 运行验证命令，检查报告路径，并限制及脱敏输出。 |
| delivery-reviewer.ts | 确定性报告审查，检查测试和未解决事项；纯报告任务允许合理的未运行测试说明。 |
| coordinator-review.ts | Coordinator 审查状态与覆盖记录，管理每个 diff 块的审查、证据确认和审查完成。 |
| coordinator-review-driver.ts | 驱动审查回合：持久化后通知协调员，覆盖不足时继续，停滞时暂停。 |
| delivery-integrator.ts | Git 候选集成、验证、冲突恢复和会议结果发布。 |
| integration-queue.ts | 将并行完成任务串行集成到一个 Meeting 分支，维护队列头和最终发布条件。 |
| meeting-delivery.ts | 汇总整场会议的任务、改动、验证、审查和限制，生成用户最终验收的交付对象。 |

## electron/backends 后端适配

同一个后端可能有无界面的协议接入和真实交互终端接入，两者不是重复文件。终端模式保留用户 CLI 的界面，通常由用户确认回合或任务完成。

| 文件 | 做什么 |
| --- | --- |
| cli-backend.ts | 所有后端遵守的接口：BackendSession、标准化消息、认证、能力、会话配置和快照。 |
| registry.ts | 注册内置和自定义后端，提供列表、查找、可用性与能力探测。 |
| backend-environment.ts | 构建中性的子进程环境，让每个适配器只注入自己的提供商凭证。 |
| canonical-execution.ts | 把不同后端的权限请求规范化成统一的读写路径、命令 argv 等执行请求。 |
| task-profile.ts | 将用户请求的模型、推理、权限等配置编译为各后端实际支持的配置，并记录降级。 |
| worker-runtime-contract.ts | 校验后端运行版本、认证和 Worker 能力；只有满足规定的真实执行证据才可获得稳定等级。 |
| subprocess-backend.ts | 通用子进程后端基类，处理启动、stdin/stdout JSONL、路径和二进制查找。 |
| custom-adapter.ts | 用户自定义 CLI 后端：名称、二进制、认证方式和 API Key/Base URL 环境变量映射。 |
| claude-code-adapter.ts | 把 ClaudeSession 包装成统一 BackendSession，将 Claude 消息转换成 Worker 信号。 |
| claude-terminal-adapter.ts | Claude 交互 TUI 的后端配置，处理二进制、Stop hook、模型和认证参数。 |
| codex-adapter.ts | Codex 消息、权限和交付适配；同时实现 SDK 会话和 app-server 会话，按配置选择。 |
| codex-app-server-transport.ts | Codex app-server 的 stdio JSON-RPC 通道、握手、账户就绪、通知和运行版本解析。 |
| codex-terminal-adapter.ts | Codex 交互 TUI 接入，通过命令行内联 TOML 注入 Stop hook，保留用户 Codex 配置。 |
| kimi-adapter.ts | Kimi 单轮 stream-json 与恢复会话，以及可选 ACP 会话的适配；标准化事件、权限和路径。 |
| kimi-acp-transport.ts | Kimi ACP 的 JSON-RPC 握手、认证、会话生命周期、通知和客户端请求响应。 |
| kimi-terminal-adapter.ts | Kimi 交互 TUI 接入，准备受管理的 KIMI_CODE_HOME 和 Stop hook。 |
| qoder-adapter.ts | 使用 Qoder 官方 Agent SDK 创建多轮会话和权限桥；不通过猜测 CLI 参数兜底协议接入。 |
| qoder-terminal-adapter.ts | Qoder 交互 TUI 接入；没有通用 Stop hook，完成确认使用相应终端策略。 |
| opencode-adapter.ts | 通过自管 opencode serve、SDK 请求和 SSE 事件实现会话、权限、消息与交付信号。 |
| opencode-server-process.ts | 查找并启动 OpenCode 服务，配置受限环境、随机 Basic Auth、模型提供商和进程退出。 |
| opencode-events.ts | 解析 SSE，关联 sessionID，规范化消息，处理权限事件和断线重同步。 |
| opencode-editor-panel.ts | 编辑器状态、Todo、diff、活动事件仓库，以及向对应 host 窗口分发事件的规则。 |
| pocket-vibe-adapter.ts | HTTP 远端后端：查询会话目录，向明确远端目标提交任务，轮询结果、转换报告和会议命令，并处理恢复及取消。 |
| pocket-vibe-target.ts | 远端目标引用的类型、解析、唯一键、标签和点名绑定；远端 cwd 不能作为本机路径解析。 |
| terminal-cli-adapter.ts | 多种交互 TUI 共用的会话骨架：PTY、bracketed paste、启动就绪、Stop hook、回合标记和完成确认。 |
| terminal-login.ts | 通过真实终端启动需要用户交互的 CLI 登录流程。 |

Pocket Vibe 的 Hub 和电脑端 Bridge 在相邻项目中，不在 station-ctrl 源码目录。当前公网模式的身份、配对和真实取消，与历史 LAN Token 模式的行为存在差别，应以 PUBLIC_REMOTE_CONTROL.md 和远端会话文档为准。

## electron/claude-cli 协议驱动

| 文件 | 做什么 |
| --- | --- |
| driver.ts | 直接执行 Claude CLI stream-json 协议，处理初始化、用户消息、控制请求和流式输出；当前 ClaudeSession 使用这一驱动。 |
| transport.ts | 管理 Claude 子进程的 stdin/stdout/stderr，按行发送与解析 JSON，处理控制请求的等待和退出。 |
| inproc-mcp.ts | 在应用进程内定义 MCP 工具，并通过 Claude CLI 控制通道处理 MCP JSON-RPC。 |
| resolve.ts | 按设置选择用户 PATH 中的 Claude 或随应用附带的二进制，构造适用的启动目标。 |
| types.ts | Claude CLI 输入、输出、权限、会话和初始化协议类型，保留应用需要的 SDK 兼容形状。 |

## electron/ipc 界面与主进程通信

这些文件把“界面调用 API”转换为业务操作。session 是单场会议操作，sessions 是会议标签的打开、切换和关闭。

| 文件 | 做什么 |
| --- | --- |
| context.ts | IPC 模块共享上下文，提供主窗口、SessionRegistry、事件发送和权限等依赖。 |
| validators.ts | 新 IPC 通道的统一入口：先检查发送窗口身份，再用 schema 校验请求。 |
| session.ts | 发送用户消息、打断、审批、主持人及远端成员等单会议操作。 |
| sessions.ts | 创建、关闭、切换和列举会议，恢复项目标签，并保存打开标签状态。 |
| tasks.ts | 提供任务快照、事件游标和协作操作，向界面输出有边界的任务投影。 |
| meeting-delivery.ts | 整场会议最终交付的查询、接受、返工和相关事件推送。 |
| auth.ts | Claude 默认认证及配置接口，探测登录状态、保存配置并启动登录。 |
| backend-auth.ts | 按后端管理认证、模型、地址、安装、默认选择、后端探测和远端会话目录。 |
| settings.ts | 读写应用偏好、语音参数、声纹等设置，并通知其他窗口更新。 |
| settings-window.ts | 打开和关闭独立设置窗口，以 view=settings 载入同一前端入口。 |
| memory.ts | 长期记忆的列举、编辑、删除等界面接口。 |
| decision.ts | 用户决策文档及相关交互接口。 |
| dialog.ts | 选择项目目录及确认该目录的授权，供桌面和掌机选择器使用。 |
| desktop.ts | 获取屏幕捕获源和屏幕共享权限，接入 macOS 系统捕获选择器。 |
| accessibility.ts | 查询和引导 macOS 辅助功能权限。 |
| device-diagnostics.ts | 收集显示器、GPU 等设备诊断信息并返回给界面。 |
| asr.ts | 讯飞识别流的开始、音频帧、结束和取消；看门狗清理无人继续发送的识别流。 |
| attachments.ts | 接收附件、抽取文本或图片，把内容发给对应会议，过大附件保存为工作区文件。 |
| documents.ts | 在已授权项目范围读取交付文件、列目录，以及交付验收后的 Worker 指令。 |
| transcripts.ts | 按项目加载、追加和清空对话历史；追加采用单向事件减少高频往返。 |
| skills.ts | 技能列表、安装和卸载接口。 |
| browser.ts | 内嵌浏览器的标签管理、导航、位置同步和可见性接口。 |
| opencode-editor.ts | 打开和关闭员工编辑器、查询状态、绑定 overlay 与保存编辑器场景；名称保留历史 OpenCode 前缀，内部已使用通用 IDE 注册表。 |
| ide-registry.ts | IDE 列表、默认 IDE 和按 Host 覆盖的设置接口。 |
| ide-files.ts | 根据发送窗口绑定确定工作区，安全地列、读、写文件；校验真实路径、符号链接和保存时的 mtime 冲突。 |
| ide-pty.ts | 主进程代理 OpenCode 编辑器终端的 REST 和 WebSocket，持有认证并控制输入速率。 |
| worker-pty.ts | 让主窗口连接已有 Worker PTY，回放输出、输入、改尺寸、断开，并确认终端任务结果。 |
| shell-pty.ts | 为主窗口 shell 面板创建、输入、调整和销毁 PTY，生命周期由界面控制。 |
| popout-window.ts | 创建会议或舞台标签的弹出窗口；对应前端目前是占位视图。 |

## electron/asr 与 electron/attachments

| 文件 | 做什么 |
| --- | --- |
| asr/xfyun-iat.ts | 讯飞 IAT 流式识别客户端：HMAC 签名 URL、音频分帧、WebSocket 会话和识别结果拼接。 |
| asr/ws-transport.ts | 使用 ws 包实现 Node/Electron WebSocket，呈现握手及认证错误。 |
| asr/pcm16.ts | 将 Float32 音频转换为带限幅的 16 位小端 PCM。 |
| attachments/parse.ts | 按 MIME 和文件类型解析文本、Word、PDF 或图片，生成可发送的内容及尺寸信息。 |
| attachments/workspace.ts | 将非内联附件安全保存到 .vibe-attachments，清理文件名、解决重名并更新忽略规则。 |
| attachments/assets.ts | 把图片和附件保存为 .vibe-assets 资源，列出资源及经过授权的引用。 |
| asr-polish.ts | 使用配置的模型把识别文本润色为书面文字；失败时返回原始识别内容。此文件位于 electron 根目录。 |

## electron/ide 编辑器管理

| 文件 | 做什么 |
| --- | --- |
| ide-adapter.ts | 通用 IDE 适配器接口和能力描述，使编辑器窗口不绑死某个后端。 |
| ide-registry.ts | IDE 目录、检测、默认选择和按 Host 覆盖的持久化。 |
| ide-window-manager.ts | 按 hostId 管理独立编辑器窗口、工作区绑定和事件接收身份。 |
| editor-scene.ts | 保存与恢复选中文件、滚动等编辑器场景，用于 overlay 与窗口互相迁移。 |
| editor-highlight.ts | 文件扩展名到 Shiki 语言的映射；渲染进程有对应镜像。 |
| opencode/opencode-editor-adapter.ts | OpenCode 的 IDE 适配器，声明可用面板并连接窗口；也包含其他 IDE 的能力占位实现。 |
| opencode/opencode-server-registry.ts | 同一 meetingId 和 cwd 共享 OpenCode 服务，通过引用计数、生命周期和历史记录清理管理进程。 |

## electron/observe 外部会话观察

这套观察层主要通过本机进程表和客户端状态文件识别外部会话，与通过 Hub 调用远端已有会话的 Pocket Vibe 路径不同。当前进程扫描实现放在 darwin.ts，不应把它理解为已覆盖所有平台。

| 文件 | 做什么 |
| --- | --- |
| types.ts | 外部客户端种类、进程与文件信号、状态、会话和快照类型。 |
| observe-service.ts | 快慢两种扫描节奏，组合进程、状态文件和桌面信号，生成并发布观察快照。 |
| correlate.ts | 将进程与文件信号合并为会话行，推导项目身份、标题、客户端和状态。 |
| mapping.ts | 将 PID 与原生会话 ID 关联，处理命令参数、PID 文件及打开文件等线索，排除本应用和 MCP 进程。 |
| state-machine.ts | 根据 CPU、未闭合工具调用和对话尾部等信号推断思考、执行、等待和完成。 |
| board-visibility.ts | 观察会话在任务看板和 AhaBar 的可见性及排序规则。 |
| session-actions.ts | 按用户意图解析外部会话，执行聚焦或受审批的文字输入；是只读观察之外的显式操作路径。 |
| util.ts | 只读文件访问、头尾采样、大小上限、脱敏、标题清理和路径安全工具。 |
| process/darwin.ts | macOS ps/lsof 扫描与解析，识别客户端进程、后代、CPU、cwd 和打开文件。 |
| statefiles/claude-projects.ts | 扫描 ~/.claude/projects 中的对话 JSONL，提取身份、真实用户消息和尾部状态。 |
| statefiles/codex-sessions.ts | 扫描 Codex CLI rollout 和会话索引，提取会话、标题及尾部状态。 |
| statefiles/codex-desktop.ts | 从 Codex 桌面本地描述和聊天进程信息识别桌面会话；不把这些数据误当完整聊天内容。 |
| statefiles/kimi-sessions.ts | 扫描 Kimi 的 session_index、state.json 和运行日志。 |
| statefiles/qoder-runs.ts | 从 Qoder 的每次运行 manifest 和日志提取原生运行与进程信息。 |

## electron/companion 陪伴屏主进程

| 文件 | 做什么 |
| --- | --- |
| companion-model.ts | 不依赖窗口的状态模型：员工座位、状态、气泡队列、提醒和聚合文案。 |
| companion-feed.ts | 把编排事件转成陪伴屏与 AhaBar 快照，跟踪审批及外部观察会话，并向浮窗推送。 |
| companion-window-manager.ts | 创建和管理置顶的陪伴屏或 AhaBar 窗口，处理展开、淡出、聚焦和关闭。 |

## src 渲染进程入口与样式

| 文件 | 做什么 |
| --- | --- |
| main.tsx | React 入口，依据 URL 的 view 参数选择主应用、设置、独立编辑器、陪伴屏、AhaBar 或弹出占位视图。 |
| App.tsx | 主应用组装层：会议和任务视图、界面布局、语音、共享屏幕、成员、审批、设置入口及远端点名发送。 |
| types.ts | 界面所用的 IPC API、会议、任务、事件、后端和编辑器类型，以及 window.vibeMeet 的类型声明。 |
| vendor-types.d.ts | 为 docx-preview 等第三方模块补充 TypeScript 声明。 |
| dev-fixture-bootstrap.ts | 显式 ui-fixture 参数开启的开发态界面样例，模拟 bridge 和数据供浏览器视觉回归；生产构建禁用。 |
| styles.css | 现有应用基础样式、组件样式、布局、深浅主题和掌机适配。 |
| aha-tokens.css | 新界面的语义设计变量，包含品牌色、风险色、字体、间距和动画等。 |
| aha-ui.css | 使用新设计变量的顶栏、状态栏、任务看板、播报条及通用组件样式。 |

## src/components 页面与会议界面

这些文件呈现信息和收集用户操作，主要业务状态来自 meeting-store，系统操作通过预加载 API 发出。

| 文件 | 做什么 |
| --- | --- |
| Lobby.tsx | 未打开会议时的项目大厅，管理最近项目、会议进入、恢复入口和初始配置。 |
| JoinScreen.tsx | 项目目录和认证配置的加入会议表单；当前主入口使用 Lobby，此组件保留在仓库。 |
| Onboarding.tsx | 首次启动的欢迎、客户端扫描和结果引导，以及后续启动的短暂 splash。 |
| AppTopBar.tsx | 会议与任务视图切换、待处理计数、设置和探索入口；部分产品入口标为开发中。 |
| TabStrip.tsx | 多项目会议标签、激活、关闭和新项目打开。 |
| MeetingHeader.tsx | 会议标题区域、视图控制和会议时长等信息。 |
| StatusBar.tsx | 客户端数量、活跃任务、访问级别、项目及会议时长状态。 |
| MeetingControls.tsx | 多 Agent 开关和自动批准档位等会议控制。 |
| BottomToolbar.tsx | 麦克风、共享、聊天、离会和陪伴屏等工具；提供掌机按钮布局及更多菜单。 |
| BroadcastStrip.tsx | 展示 Host 最新进展播报，支持打断 TTS 和关闭播报条。 |
| ObservedStrip.tsx | 展示观察到的活跃外部会话，点击跳转任务看板。 |
| ParticipantPanel.tsx | 参会者列表及 Worker 卡片，处理选中、静音、编辑器与执行视图入口。 |
| ParticipantTile.tsx | 通用参会者磁贴，显示身份、状态和选中样式。 |
| WorkerCard.tsx | Worker 卡片，呈现任务状态、后端、活动及详情入口。 |
| AgentDetailPanel.tsx | Agent 右侧详情，显示角色、任务、最近活动、产物及编辑器入口。 |
| BackendAvatar.tsx | 按后端选择内置图标或用户头像，缺省时显示通用头像。 |
| ClaudeAvatar.tsx | 早期 Claude 专用头像组件；当前源码未发现其他组件导入。 |
| ElapsedTime.tsx | 独立每秒刷新的时间显示，把定时刷新限制在此组件。 |
| SideDrawer.tsx | 聊天和项目侧边抽屉，包含对话、发送、点名、附件、审批、文件等交互。 |
| ClaudeWorkspace.tsx | Agent 工作区界面，展示对话、活动、工具调用和权限状态，也可面向具体 Worker 使用。 |
| ActivityTabContent.tsx | 按选中参与者显示 ClaudeWorkspace，或切到用户任务面板。 |
| ScreenStage.tsx | 会议中央舞台，选择屏幕共享、浏览器、文件、交付、终端或 Worker 工作台，并停靠任务检查器。 |
| SourcePicker.tsx | 选择共享的屏幕或窗口，提供权限状态和系统设置引导。 |
| StageTabBar.tsx | 舞台内部标签及新增菜单；弹出菜单时协调原生浏览器的隐藏。 |
| BrowserStage.tsx | 浏览器工具栏和原生 WebContentsView 对应的测量占位区域。 |
| BrowserToolbar.tsx | 地址栏、前进后退、刷新和浏览器标签。 |
| ExplorePage.tsx | 静态生态探索页，包含合作生态等开发中入口。 |
| PopoutPlaceholder.tsx | 会议或舞台弹出窗口的占位页面，完整弹出渲染尚未在此实现。 |

## src/components 任务交付与审批

| 文件 | 做什么 |
| --- | --- |
| TasksView.tsx | 跨项目任务看板，也展示外部观察会话；按状态分列并连接项目或任务详情。 |
| UserTasksPanel.tsx | 当前会议中用户派发任务的汇总，显示依赖、状态和可执行操作。 |
| PlanMeetingModal.tsx | 计划草稿编辑和审批，配置任务、依赖、执行后端、上下文、授权和验收标准。 |
| TaskInspector.tsx | 停靠式任务检查器，汇总任务说明、执行尝试、授权、消息、diff、验证、审查、恢复和集成证据。 |
| TaskMailboxPanel.tsx | 任务与 Host 之间的消息列表、状态和回复交互。 |
| TaskProfilePanel.tsx | 对比请求的执行配置与后端实际生效配置，展示能力降级。 |
| TaskReviewPanel.tsx | 任务检查器中的 diff、验证和集成详情视图。 |
| DeliveryViewer.tsx | 单个 Worker 交付查看，呈现文件、报告、验证、审查和反馈操作。 |
| DeliveryDiffView.tsx | 将统一 diff 转成带旧新行号的改动展示，并连接文件预览。 |
| FinalMeetingDelivery.tsx | 整场会议的最终结果面板，展示集成、验证、审查、审批和限制，提供最终接受与返工。 |
| ApprovalCard.tsx | 统一审批卡，显示项目、任务、客户端、动作，按风险决定批准交互，支持拒绝后的短暂撤销。 |
| ApprovalDetailModal.tsx | 高风险操作的影响与完整参数详情，需要阅读确认后才允许提交批准。 |
| HoldToApproveButton.tsx | 中风险按住批准按钮，默认持续 800ms，支持指针和键盘。 |
| ReviewPanel.tsx | 从工具活动提取文件改动并展示 review 列表；当前主界面未发现对此组件的直接导入。 |
| SpecPanel.tsx | 从对话呈现任务要求或说明；当前主界面未发现对此组件的直接导入。 |

## src/components 文件与终端

| 文件 | 做什么 |
| --- | --- |
| FileTree.tsx | 项目文件树，浏览目录并选择文件。 |
| FileViewer.tsx | 根据文件类型展示代码、文本、图片、PDF、Word 等，处理加载、大小和错误状态。 |
| CodePreview.tsx | 只读代码高亮与行号，懒加载 Shiki 语言支持。 |
| OpenCodeEditor.tsx | 员工独立编辑器：文件树、查看与编辑、保存、Todo、diff、活动和 PTY；可用面板取决于 IDE 能力。 |
| EditorOverlay.tsx | 掌机中的全屏编辑器覆盖层，保留主应用组件挂载，使语音链路继续工作。 |
| DirPickerModal.tsx | 应用内目录选择器，解决小屏原生选择框溢出；同时导出统一 usePickCwd 入口。 |
| TerminalPanel.tsx | 命令执行记录的展示与回放，来自 commandLog。 |
| RealTerminal.tsx | 显示真实 Worker PTY 的 xterm 终端，连接时回放缓冲，卸载只断开显示连接。 |
| PtyPanel.tsx | OpenCode 独立编辑器的服务端 PTY，通过主进程代理 WebSocket 和尺寸操作。 |
| ShellTerminal.tsx | 主窗口抽屉内的真实 shell；打开时创建，关闭时销毁。 |
| TerminalTurnConfirmBar.tsx | 终端 Worker 回合结束后的确认，供用户标记完成、继续或失败。 |
| WorkerWorkbench.tsx | 单个终端 Worker 工作台：左侧真实 TUI，右侧任务上下文、消息、回合确认和协作信息。 |

## src/components 设置与通用界面

| 文件 | 做什么 |
| --- | --- |
| SettingsMenu.tsx | 齿轮入口，通过 IPC 打开独立设置窗口。 |
| SettingsWindow.tsx | 设置总页面，组合模型、远端控制、记忆、语音、声纹、技能和 IDE 等面板。 |
| BackendSettings.tsx | 各后端的认证、Base URL、模型、默认选择、安装及自定义 CLI 配置。 |
| RemoteControlSettings.tsx | 公网远端身份和配对设置，显示设备、控制操作及任务相关状态。 |
| RemoteSessionPicker.tsx | 浏览电脑及远端已有会话，显示来源、状态，选择明确会话引用加入会议。 |
| IDEManagerPanel.tsx | 查看 IDE 检测结果和设置默认 IDE；尚未支持的 IDE 显示占位状态。 |
| MemoryPanel.tsx | 查询、筛选、编辑和删除项目或跨会议记忆。 |
| SkillManagerPanel.tsx | 列出技能、从 URL 或路径安装，并卸载用户技能。 |
| VoiceSelector.tsx | 选择中文 TTS 音色、语言和相关声音偏好，标识音色质量。 |
| VoiceLockPanel.tsx | 声纹录入、录入状态、仅听本人开关、重录和清除操作。 |
| VoiceGuideModal.tsx | 引导 macOS 用户在系统设置下载更高质量中文语音。 |
| UpcomingSettingsPanel.tsx | 账号、AhaTalk 和 AhaKey 等尚未建设后端的设置占位区块。 |
| CompanionScreen.tsx | 陪伴屏窗口入口，加载 Phaser 场景、订阅状态，并协调 TTS 与提示音。 |
| AhaBar.tsx | 浮动环境条，显示工作和审批状态，支持悬停、固定、展开及快捷批准。 |
| VirtualKeyboard.tsx | AhaBar 配套虚拟按键界面，承接相应批准、聚焦等控制。 |
| MinimizePrompt.tsx | 最小化或关闭时选择切换 AhaBar 的弹窗和不再提示选项。 |
| Modal.tsx | 通用模态容器，处理浏览器遮挡、焦点、键盘和无障碍语义。 |
| AppErrorBoundary.tsx | 捕获 React 渲染错误并显示恢复界面，避免整个窗口白屏。 |
| ToastViewport.tsx | 展示全局短提示队列，错误使用无障碍 alert。 |

## src/hooks 状态订阅与生命周期

| 文件 | 做什么 |
| --- | --- |
| useWorkers.ts | 把活动会议和 Worker 状态包装成界面使用的操作接口，连接发送、审批和任务操作。 |
| useClaude.ts | useWorkers 的旧单 Agent 界面兼容封装，合并对话、活动和首个审批项。 |
| useMeetingSelector.ts | 对 meeting-store 做细粒度订阅，避免无关事件引发整个面板刷新。 |
| useTabs.ts | 订阅多项目会议标签及活动、未读等投影。 |
| useCrossProjectTasks.ts | 订阅所有项目的任务聚合，供跨项目看板使用。 |
| useObservedTasks.ts | 订阅观察层最新会话快照。 |
| useBrowser.ts | 订阅浏览器状态，用 ResizeObserver 同步原生浏览器位置。 |
| useStageWindows.ts | 将舞台窗口仓库接入 React，并提供标签创建、切换和关闭。 |
| useScreenShare.ts | 管理屏幕共享媒体流、选择源、截取画面和停止共享。 |
| useAsr.ts | 讯飞可用性探测和语音采集的统一入口；缺凭证时不会自动换浏览器识别。 |
| useVoiceCapture.ts | 麦克风与 VAD 主链路：音频帧、讯飞流、声纹门禁、TTS 回声抑制、打断与最终文本。 |
| useVoiceLock.ts | 主窗口的声纹录入、嵌入比较、偏好和状态同步。 |
| useRemoteVoiceLock.ts | 设置窗口通过 IPC 远程驱动主窗口声纹录入，不在设置窗口另开采集链路。 |
| useVoicePreferences.ts | 加载、编辑、保存声音和语言偏好，处理保存并重连状态。 |
| useSpeech.ts | React 音色订阅与语音模块的导出门面；实际播放控制在 speech-session。 |
| useTtsWiring.ts | 将 Agent 文本事件接到 TTS，处理回合结束及与陪伴屏音效互斥。 |
| useSpacebarMute.ts | 空格键临时静音的键盘行为。 |
| usePtyTerminal.ts | xterm 与 FitAddon 生命周期、resize、数据解码、退出和 PTY 连接共用逻辑。 |
| useAutoScroll.ts | 自动滚动及用户主动离开底部时的行为。 |
| useDragAndDrop.ts | 拖入文件时的界面状态与事件处理。 |
| useTimer.ts | 计算经过秒数和格式化会议时间。 |

## src/lib 状态与任务逻辑

| 文件 | 做什么 |
| --- | --- |
| meeting-store.ts | 核心界面状态仓库：按会议槽位保存 Host、Worker、对话、计划、审批和交付，处理 IPC 事件及跨项目聚合。 |
| browser-store.ts | 内嵌浏览器状态、标签和显示隐藏操作；模态界面可请求暂时隐藏原生视图。 |
| stage-window-store.ts | 舞台动态标签、选中窗口、文件或 Worker 关联的状态。 |
| observed-store.ts | 外部会话观察快照及订阅，包含主进程观察类型的界面镜像。 |
| task-event-reducer.ts | 把持久化任务事件投影成检查器状态，处理重复和事件缺口。 |
| worker-event-reducer.ts | 把通用 Worker 信号变成进展、工具、命令日志、报告和终态。 |
| worker-event-schema.ts | 渲染进程的 WorkerEvent schema，需与主进程协议保持一致。 |
| task-columns.ts | 任务状态中文名、看板分列和有效状态选择，统一多处界面的状态词表。 |
| worker-capacity.ts | 计算占用并发槽位的任务、等待任务及依赖是否已满足。 |
| plan-validation.ts | 规范化计划草稿，验证执行后端、验收标准、命令和依赖。 |
| task-budget.ts | 主进程预算默认值的界面镜像，供计划草稿规范化使用。 |
| dependency-gate.ts | 推断和展示依赖释放门槛，区分执行完成、审查通过等阶段。 |
| delivery-acceptance.ts | 判断单任务 Host 接受操作是否可用，解释纯报告和冻结延后等情况。 |
| delivery-feedback.ts | 识别简短肯定反馈，避免把“好、可以”等误当返工请求。 |
| dispatch-mode.ts | 构建规划或直接执行的用户消息指令，包括附件的派发模式。 |
| terminal-backends.ts | 真实 TUI Worker 后端 ID 的界面镜像及判断函数。 |
| voice-final.ts | 最终语音文本的生产发送逻辑：唯一远端成员点名、歧义提示、技能和本机后端名称匹配。 |
| risk-classify.ts | 界面侧操作风险判断及说明，决定单击、按住或详情审批；主进程仍独立执行权限策略。 |
| sdk-message.ts | 从 SDK 兼容消息中提取文本和工具调用，并生成界面 ID。 |
| toast.ts | 不依赖 React 的全局提示仓库，供组件、Hook 和其他仓库统一反馈。 |
| format-error.ts | 把异常转成可读界面错误文字。 |
| handheld-mode.ts | 主进程模式判断的界面镜像，另提供 Hook 驱动根元素的掌机或桌面类名。 |
| display-migration.ts | 外接屏迁移规划的渲染进程镜像。 |
| editor-highlight.ts | 扩展名到代码语言的渲染进程镜像。 |
| shiki-highlighter.ts | 懒加载 Shiki 主题、WASM 引擎和语言语法，生成高亮 HTML。 |

## src/lib 音频与陪伴屏

| 文件 | 做什么 |
| --- | --- |
| microphone-ui-state.ts | 规范化麦克风状态、音量和异步操作顺序，支持失败重试的正确界面状态。 |
| mic-level.ts | 高频麦克风幅度通道，把逐帧更新从 React 主树分离出来。 |
| fbank.ts | 16kHz 音频的 80 维 log-mel 特征提取，生成 CAM++ 声纹模型需要的输入。 |
| speaker-embedding.ts | 声纹 Web Worker 门面，加载模型、提取嵌入、计算余弦相似度和平均声纹。 |
| speaker-embedding.worker.ts | 在独立 Web Worker 运行 fbank 和 ONNX 推理，避免识别时阻塞界面线程。 |
| speech-format.ts | 清理 Markdown、代码和工具噪声，检测语言、摘要和分句，把文本变成适合朗读的内容。 |
| speech-session.ts | TTS 播放控制器，管理队列、分句、回合完成、打断、播放状态和预热。 |
| voice-registry.ts | 缓存系统音色、等待音色加载、保存选择，并按语言选取音色。 |
| voice-quality.ts | 识别中文音色的质量档位及语言区域，生成音色选择列表。 |
| companion/companion-game.ts | Phaser 像素办公室场景，用角色、工位、气泡和动画显示员工状态。 |
| companion/companion-sound.ts | 用 Web Audio 振荡器生成不同级别提示音，不依赖音频文件。 |

## src/skills 与头像素材

| 文件 | 做什么 |
| --- | --- |
| skills/grill-me/SKILL.md | grill-me 技能别名，转到 grilling 设计追问流程。 |
| skills/grilling/SKILL.md | 通过逐题追问验证计划和设计的 Agent 技能正文，不是 React 运行代码。 |
| assets/cli-icons/Claude.gif | Claude 默认头像素材。 |
| assets/cli-icons/codex.jpeg | Codex 默认头像素材。 |
| assets/cli-icons/kimi.jpeg | Kimi 默认头像素材。 |
| assets/cli-icons/qoder.png | Qoder 默认头像素材。 |

## scripts 开发构建与真实环境检查

| 文件 | 做什么 |
| --- | --- |
| dev-electron.mjs | 跨平台开发启动器：编译主进程、复制 preload、设置开发服务地址并启动 Electron。 |
| clean-dist-electron.mjs | 重建前清空主进程输出，避免删除过的旧源码仍以 JS 副本进入安装包。 |
| copy-preloads.mjs | 将未经过 tsc 编译的 preload*.cjs 复制到主进程输出目录。 |
| bundle-claude-defaults.mjs | 从开发环境整理 Claude 默认 agents、skills、commands、rules 和相应插件，放到打包资源目录。 |
| fetch-speaker-model.mjs | 获取 CAM++ 声纹 ONNX 模型并放入 public/voice-id，支持已有文件及缓存复用。 |
| lib/asset-cache.mjs | 构建资产的持久磁盘缓存，提供缓存路径、目录创建、尺寸检查，以及硬链接或复制到目标。 |
| generate-release-manifest.mjs | 生成发布包 SHA256SUMS，并按配置生成 GPG 签名。 |
| verify-macos-signing.mjs | 检查 macOS Developer ID 签名、TeamIdentifier 和麦克风权限声明。 |
| verify-linux-arm64-package.mjs | 解包检查 Linux ARM64 发布物、运行库及所需后端二进制。 |
| make-local-deb.py | 手工组装兼容的 Debian 包，解决 macOS 交叉打包时 ar/fpm 的问题。 |
| e2e-opencode-smoke.mjs | 使用真实 OpenCode 适配器和服务测试事件、权限及恢复链路；需要提供模型凭证。 |
| real-worker-stability-smoke.mjs | 显式启用的真实 Claude/Codex Worker 纵向烟测，在临时 Git 仓库产生版本绑定的执行证据。 |
| observe-smoke.mjs | 在真实机器上运行只读观察服务，输出脱敏后的会话发现结果。 |
| thermal-log.sh | RK3588 温度、CPU 频率和负载采样，按阈值生成散热压测报告。 |
| board/verify-rk3588.sh | 板端环境、运行版本及应用相关能力的验收检查。 |
| board/runtime-versions.env | 板端严格检查所使用的运行时版本基线。 |

## tests 自动化测试

测试使用 Node 的 test runner，许多主进程模块通过编译后的 dist-electron 加载。模拟测试覆盖协议和业务规则；真实 CLI、窗口操作和板端验收由对应 smoke 脚本或人工验收补充。

下表完整列出 118 个测试文件，并说明各自重点。

| 文件 | 主要验证什么 |
| --- | --- |
| affirmative-delivery-feedback.test.mjs | 简短肯定语句映射接受，真实修改建议保留返工语义。 |
| approval-gesture.test.mjs | 工具风险到单击、按住、详情审批的映射。 |
| asr-stream-watchdog.test.mjs | 识别流空闲回收，持续音频维持连接，以及结束后的清理。 |
| backend-base-url.test.mjs | 模型服务地址规范化及配置持久化。 |
| backend-canonical-execution.test.mjs | 后端请求转成统一执行请求，精确保留 argv，拒绝无法解析的 shell。 |
| backend-capability-gates.test.mjs | Worker 能力门禁、真实证据要求与稳定等级。 |
| backend-environment-isolation.test.mjs | 不同后端不会收到其他提供商凭证。 |
| backend-probe.test.mjs | 区分运行时、认证和角色能力，避免只凭保存 API Key 判定就绪。 |
| backend-runtime-auth.test.mjs | 后端二进制查找及真实认证状态探测。 |
| backend-task-profile.test.mjs | 各后端模型、推理强度等执行配置的编译和降级。 |
| claude-adapter-config.test.mjs | Claude 通用配置传递、语义信号转换和持续会话指导。 |
| claude-cli-driver.test.mjs | 自有 Claude CLI 驱动的启动参数、初始化、消息和控制协议。 |
| claude-session-readiness.test.mjs | Claude 无认证或无有效凭证来源时拒绝就绪。 |
| claude-terminal-adapter.test.mjs | Claude TUI 的粘贴、回合标记、hook 和终端会话机制。 |
| codex-adapter.test.mjs | Codex 模型配置、会议命令、Worker 信号和严格报告。 |
| codex-app-server-transport.test.mjs | app-server 初始化、账户探测及 JSON-RPC 通信。 |
| codex-runtime.test.mjs | Codex 原生运行程序的查找与优先级。 |
| codex-terminal-adapter.test.mjs | Codex TUI 参数、Stop hook、批准和模型映射。 |
| collaboration-recovery.test.mjs | 仅明确只读授权可自动继续，旧状态不获得新授权或验收证据。 |
| collaboration-vertical-slice.test.mjs | 注入审查的多后端会议协作完整纵向流程。 |
| companion-model.test.mjs | 座位保留和分配、气泡、员工状态及提醒汇总。 |
| coordinator-diff-review.test.mjs | 冻结候选路径、diff 分块、漏报拒绝及返工候选处理。 |
| coordinator-review-driver.test.mjs | 审查记录先落盘、完成幂等、有限续推及停滞暂停。 |
| coordinator-review-loop.test.mjs | 未完成审查继续回合，审查期拒绝其他协调工具。 |
| delivery-harness.test.mjs | 完成报告必须经独立验证和审查，事件游标与验收状态顺序。 |
| delivery-integrator.test.mjs | 旧逐任务发布路径的禁用和集成边界，保护用户基线。 |
| delivery-reviewer.test.mjs | 验证失败和未解决事项导致拒绝，纯报告的未运行测试可告警。 |
| delivery-snapshot.test.mjs | 文件复制、哈希、大小限制及路径越界拒绝。 |
| delivery-verifier.test.mjs | 精确 argv 验证、路径约束、输出上限及脱敏。 |
| dir-list.test.mjs | 隐藏目录、大小写排序和只列子目录。 |
| editor-derived-diff.test.mjs | 从工具变化推导 diff 计数，避免空服务器结果抹掉已知改动。 |
| editor-panel-fanout.test.mjs | 编辑器状态更新只发往相应 Host 的窗口。 |
| handheld-mode.test.mjs | 用户覆盖与自动触摸、小屏模式判断。 |
| host-ask-watchdog.test.mjs | Host 提问超时提醒，以及提前答复后的定时器取消。 |
| host-message-truncation.test.mjs | 过长 Host 消息截断而非丢弃。 |
| ide-files-security.test.mjs | 编辑器文件真实路径、符号链接和工作区边界。 |
| ide-pty-files.test.mjs | 编辑器 PTY 输入大小和速率、窗口终端绑定和相关校验。 |
| ide-registries.test.mjs | IDE 与 OpenCode 服务注册表、共享和引用计数生命周期。 |
| integration-queue.test.mjs | 并行候选串行集成、失败回滚和冲突清理。 |
| ipc-validators.test.mjs | IPC 发送者及输入 schema 校验，拒绝额外字段和非法请求。 |
| kimi-acp-transport.test.mjs | Kimi ACP 认证、持续会话和同通道请求响应。 |
| kimi-adapter.test.mjs | Kimi 单轮启动参数、原生会话恢复和事件转换。 |
| kimi-terminal-adapter.test.mjs | Kimi TUI 的管理目录、Stop hook 和用户登录状态。 |
| linux-arm64-release.test.mjs | ARM64 发布流程顺序、产物和 Linux CI 架构配置。 |
| macos-signing.test.mjs | 接受正确 Developer ID 签名，拒绝临时签名和缺失麦克风权限。 |
| meeting-command-execution.test.mjs | Coordinator 对运行中计划执行带版本修订并记录事件。 |
| meeting-command.test.mjs | 会议命令 schema、角色权限及计划边界。 |
| meeting-final-delivery.test.mjs | 最终交付条件、证据边界和精确会议分支的一次性发布。 |
| meeting-plan-brief.test.mjs | 完整计划文档保留，以及从裸任务合成计划步骤。 |
| meeting-recovery.test.mjs | 重启后任务变中断、事件序列延续、不擅自重放执行。 |
| microphone-access.test.mjs | macOS 初次授权、已拒绝后的设置引导及跨平台分支。 |
| microphone-ui-state.test.mjs | 麦克风初始化、失败重试及缺少识别凭证的状态。 |
| minimize-prompt.test.mjs | 最小化提示条件，以及选择 AhaBar 或直接隐藏的结果。 |
| multi-backend-worker-smoke.test.mjs | 模拟多后端并发和日志事件一致性，模拟结果不能提升稳定等级。 |
| observe-board-visibility.test.mjs | 外部会话可见窗口、活跃状态和看板排序。 |
| observe-codex-desktop.test.mjs | Codex 桌面描述与聊天进程关联，cwd、标题和能力标识。 |
| observe-correlate.test.mjs | 完整样例树信号关联、自身会话排除和 MCP 抑制。 |
| observe-kimi.test.mjs | Kimi 索引路径限制、去重、缺失文件和日志解析。 |
| observe-mapping.test.mjs | 命令参数、PID 文件和打开文件的会话映射。 |
| observe-process.test.mjs | ps/lsof 格式、进程匹配、后代和命令行保留。 |
| observe-session-actions.test.mjs | 外部会话文字输入清理、长度、限流及目标操作规则。 |
| observe-state-machine.test.mjs | CPU 与对话信号到执行、思考、等待和完成的状态推断。 |
| observe-statefiles.test.mjs | Claude/Codex 状态文件扫描与真实用户消息识别。 |
| opencode-custom-provider.test.mjs | 自定义 OpenCode 模型提供商配置的生成及缺失信息拒绝。 |
| opencode-event-pipeline.test.mjs | 服务 banner、SSE 事件、会话归属、权限和重同步。 |
| opencode-window-manager.test.mjs | 编辑器窗口按 hostId 唯一，避免同后端参与者冲突。 |
| orchestrator-cleanup.test.mjs | 完成交付与提前退出的清理、依赖级联和全部终止。 |
| overlay-migration.test.mjs | 编辑器场景序列化及双屏形态切换。 |
| permission-approval-memory.test.mjs | 完全相同请求的批准指纹复用，拒绝及特殊副作用不产生自动记忆。 |
| permission-broker.test.mjs | 后端工具名和风险映射、批准决策、超时与安全降级。 |
| phase6b-release.test.mjs | 版本比较和最新发布重定向解析等发布阶段逻辑。 |
| plan-revision.test.mjs | 原子添加、取消和指导，拒绝过期版本与破坏执行边界的修订。 |
| plan-task-profile.test.mjs | 任务执行配置和授权完整性，旧计划的保守规范化。 |
| pocket-vibe-adapter.test.mjs | Hub 排队到完成、失败、报告缺失、角色及认证适配。 |
| pocket-vibe-cancellation-races.test.mjs | 原生桌面目标与运行状态，迟到取消不能影响更新的 turn。 |
| pocket-vibe-remote-sessions.test.mjs | 明确远端目标优先、会话目录刷新、身份恢复、成员隔离与容量门禁。 |
| pty-host.test.mjs | 输出环形缓冲、容量裁剪和 PTY 管理。 |
| qoder-adapter.test.mjs | 官方 SDK 多轮会话就绪、权限及打断与关闭区别。 |
| qoder-runs.test.mjs | Qoder manifest 解析、异常容错和最新运行排序。 |
| qoder-terminal-adapter.test.mjs | Qoder TUI 工作区参数、无 hook 策略和模型批准参数。 |
| remote-control-public.test.mjs | 公网身份加密、配对接口、幂等提交、重启恢复和实际退出证明。 |
| renderer-command-log.test.mjs | 按 callId 合并命令开始完成，乱序处理和日志容量。 |
| renderer-delivery-acceptance.test.mjs | Host 接受操作说明，以及冻结延后交付不能被错误接受。 |
| renderer-dev-fixture.test.mjs | 界面样例仅在开发态和显式参数下生效。 |
| renderer-final-meeting-delivery.test.mjs | 最终接受入口、证据展示及类型化 IPC 连接。 |
| renderer-plan-validation.test.mjs | 计划草稿后端、标准和命令校验及安全默认值。 |
| renderer-remote-sessions.test.mjs | 切换标签后远端回复仍归属原会议，恢复引用及发送路径门禁。 |
| renderer-security.test.mjs | CSP、ONNX 执行、跨源隔离和资源协议目录限制。 |
| renderer-task-event-reducer.test.mjs | 任务事件幂等、缺口刷新和跨任务隔离。 |
| renderer-task-inspector.test.mjs | 任务检查器入口、所有必需证据及请求与生效配置显示。 |
| renderer-worker-capacity.test.mjs | 并发槽位、等待任务和审查依赖释放的界面计算。 |
| renderer-worker-event-reducer.test.mjs | 跨后端信号投影、错误来源和乱序拒绝，以及终态显示。 |
| risk-classify.test.mjs | 读、写、shell 等操作的前端风险分类。 |
| scheduler-collaboration-defects.test.mjs | 结束与启动竞态、迟到报告和旧执行尝试的消息隔离。 |
| scheduler-priority.test.mjs | 优先执行阻塞下游最多的任务，同权 FIFO 和并发上限。 |
| session-resume.test.mjs | OpenCode 会话新建、恢复和失效后的明确降级。 |
| shell-pty.test.mjs | 不同平台默认 shell 的选择。 |
| skills-url-resolution.test.mjs | skills.sh、GitHub 和其他技能来源的真实资源 URL 解析。 |
| task-authority.test.mjs | 计划授权绑定、精确命令、读写路径、别名路径和追加授权。 |
| task-budget.test.mjs | 默认无限预算、显式限额和重复失败不收敛判定。 |
| task-collaboration.test.mjs | 严格任务协作 schema、状态枚举、未知字段和数值边界。 |
| task-columns.test.mjs | 活跃 Worker 状态优先于过期计划状态。 |
| task-context.test.mjs | 上下文模式、确定性包、授权引用和附件内容哈希。 |
| task-intent.test.mjs | 文本任务意图、命令类型、安全写目录和依赖默认值。 |
| task-ipc.test.mjs | 安全任务快照、日志游标和审查证据投影。 |
| task-mailbox.test.mjs | 先持久化再投递，重复 ID 幂等，送达与确认独立。 |
| task-message-routing.test.mjs | 指导消息 FIFO，等待回合结束，以及缺失报告的一次性纠正。 |
| task-projection.test.mjs | 日志投影、非法状态转换和终态后的迟到事件拒绝。 |
| task-workspace-dirty-baseline.test.mjs | 脏基线区分、明确只读允许，以及写任务在修改前被阻止。 |
| task-workspace.test.mjs | 非 Git 工作区的路径锁、父子目录冲突及整体工作区锁。 |
| task-write-path-poison.test.mjs | 写路径逃逸拒绝、非 Git 模式规范化和任务 ID 重用处理。 |
| voice-pref.test.mjs | 声音偏好字段映射、显式清空和非法值拒绝。 |
| worker-delivery-slice.test.mjs | 交付与依赖释放、并发饱和提醒和等待验收任务释放执行槽位。 |
| worker-event-schema-parity.test.mjs | 主进程与渲染进程 WorkerEvent、任务状态 schema 一致。 |
| worker-protocol.test.mjs | 严格 WorkReport、跨后端信号和工具输出大小限制。 |
| worker-question-redelivery.test.mjs | Coordinator 暂离期间积压问题在恢复后重新送达。 |
| worker-runtime-contract.test.mjs | 运行版本解析、缺失和未认证拒绝、测试基线版本门禁。 |
| xfyun-iat.test.mjs | PCM 转换、讯飞 HMAC 鉴权、分帧和识别结果组合。 |

### 测试基础设施与样例目录

| 文件或目录 | 做什么 |
| --- | --- |
| electron-stub.mjs | Node 测试加载钩子，把 electron 模块重定向到模拟实现。 |
| electron-stub-impl.mjs | 模拟 app、窗口、IPC 和 safeStorage 等，使测试无需真正启动 Electron。 |
| fixtures/coordinator-review-candidate.json | 冻结候选和 Coordinator 审查的固定数据。 |
| fixtures/observe/ps-sample.txt | macOS 进程表样本，测试进程解析和关联。 |
| fixtures/observe/lsof-sample.txt | 文件句柄与 cwd 样本，测试进程到会话映射。 |
| fixtures/observe/home/ | 模拟用户 HOME，其隐藏目录均是测试输入，不是当前用户真实配置。 |
| fixtures/observe/home/.claude/projects/ | 三个编码项目目录：project-alpha、project-beta 和临时 e2e；各自 JSONL 模拟 Claude 会话。 |
| fixtures/observe/home/.codex/.codex-global-state.json | Codex 全局桌面状态样本。 |
| fixtures/observe/home/.codex/process_manager/chat_processes.json | Codex 桌面聊天进程样本。 |
| fixtures/observe/home/.codex/session_index.jsonl | Codex CLI 会话标题索引样本。 |
| fixtures/observe/home/.codex/sessions/2026/07/23/ | 一个历史 rollout JSONL，会话身份和尾部事件样本。 |
| fixtures/observe/home/.codex/sessions/2026/07/24/ | 两个 rollout JSONL，用于区分同日不同会话及活动状态。 |
| fixtures/observe/home/.kimi-code/session_index.jsonl | Kimi 会话目录索引样本。 |
| fixtures/observe/home/.kimi-code/workspaces.json | Kimi 工作区记录样本。 |
| fixtures/observe/home/.kimi-code/sessions/ | 两组工作区和会话子目录，每组 state.json 提供会话身份及标题。 |

## public 与打包资源

public 中的模型、JS 和 WASM 是运行资源。尤其 public/vad 中的 JS/MJS 是第三方构建产物，不应按应用自有业务代码阅读。

| 文件 | 做什么 |
| --- | --- |
| public/icon-96.png | 前端使用的小尺寸应用图标。 |
| public/vad/silero_vad_v5.onnx | Silero VAD 模型，判断音频帧中是否有人说话。 |
| public/vad/vad.worklet.bundle.min.js | 麦克风音频的 VAD AudioWorklet 打包代码。 |
| public/vad/ort-wasm-simd-threaded.mjs | ONNX Runtime 浏览器 WASM 加载与桥接代码。 |
| public/vad/ort-wasm-simd-threaded.wasm | 支持 SIMD 和线程的 ONNX 推理运行时。 |
| public/vad/ort-wasm-simd-threaded.jsep.mjs | ONNX Runtime JSEP 变体的 JS 桥接模块。 |
| public/vad/ort-wasm-simd-threaded.jsep.wasm | 对应 JSEP 变体的 WASM 推理运行时。 |
| public/voice-id/3dspeaker_campplus_sv_zh_en_16k.onnx | CAM++ 声纹嵌入模型，供“仅听本人”使用。 |
| resources/remote-service.json | 随包提供的远端服务地址与协议版本；当前地址为空，协议为 2。 |
| build/icon.icns | macOS 应用和安装包图标。 |
| build/icon.ico | Windows 安装包与应用图标。 |
| build/icon.png | Linux 等平台使用的应用图标。 |
| build/ahastationicon.jpg | AhaStation 图标原始素材。 |
| build/entitlements.mac.plist | macOS hardened runtime 所需权限声明，包含音频输入等。 |
| cliicon/Claude.gif | 原始 Claude 图标素材。 |
| cliicon/codex.jpeg | 原始 Codex 图标素材。 |
| cliicon/kimi.jpeg | 原始 Kimi 图标素材。 |
| cliicon/qoder.png | 原始 Qoder 图标素材。 |

## docs 文档逐文件说明

文档记录的方案、版本和机器路径可能属于历史阶段。当前语音识别实现是讯飞 IAT；Whisper 方案保留的是旧设计。远端控制的当前行为需要同时参考最新交接文档，不能只沿用最初 LAN 说明。

| 文件 | 内容 |
| --- | --- |
| POCKET_VIBE_BACKEND.md | Pocket Vibe 后端交接说明，包含当前未提交工作、历史开发环境、调用协议和后续增量。 |
| POCKET_VIBE_REMOTE_SESSIONS.md | 选择远端已有会话的用法，身份、互斥、恢复权限、进程清理和验证边界。 |
| PUBLIC_REMOTE_CONTROL.md | 公网身份、配对、电脑端 Bridge、真实取消、共享桌面执行和验收记录。 |
| PUBLIC_REMOTE_TEST_BASELINE.json | 公网远端测试的结构化基线数据。 |
| RK3588_DEPLOYMENT.md | RK3588 / Debian 11 的锁定环境、构建、安装和运行验收。 |
| adr/0001-meeting-owned-visible-task-collaboration.md | 架构决策：由 Meeting 持有可见任务协作及相关取舍。 |
| orchestrator-v2-progress.md | Orchestrator V2 实施进度、验证记录和未完成验收。 |
| plan-orchestrator-v2.md | 编排器 V2 的领域模型、根因和完整优化方案。 |
| plans/2026-07-24-meeting-task-collaboration-design.md | 会议任务协作详细设计及产品决策。 |
| plans/2026-07-24-meeting-task-collaboration.md | 任务协作的分里程碑实施步骤。 |
| plans/2026-07-24-worker-protocol-delivery-loop.md | 多后端 Worker 协议与交付闭环实施计划。 |
| plan-client-software-detail.md | 客户端进程架构、模块、安全和软件层细化方案。 |
| plan-phase2-ide-handheld.md | IDE 适配、掌机 UI、双屏和陪伴屏分阶段方案。 |
| plan-main-ipc-fix.md | 启动关键路径、IPC、影子目录、异步存储和预热修复方案。 |
| plan-meeting-autosave.md | 会议结束后自动总结并保存记忆的方案。 |
| plan-asr-whisper.md | 旧 Whisper 本地识别方案，当前已由讯飞链路替代。 |
| plan-tts-streaming.md | TTS 分句、流式消费、合成和播放修复设计。 |
| audit-2026-05-31.md | 当时的播报截断、卡点静默、代码和安全问题审计。 |
| probe-renderer-ipc.md | 渲染线程计算和 IPC 延迟排查。 |
| probe-tts-output.md | 模型回复到扬声器首字的输出侧延迟排查。 |
| tts-research-A-macos.md | macOS 系统 TTS、中文音色和安装体验的历史可行性调查。 |
| tts-research-B-opensource.md | 开源本地 TTS 引擎、打包约束和候选方案调查。 |
| e2e-phase2-checklist.md | OpenCode 全链路 GUI 与无头 smoke 的验收清单。 |
| spike-opencode-server.md | OpenCode 服务二进制、启动、鉴权、SSE 和 PTY 的实测记录。 |
| research-claude-kimi-codex-harness.md | Claude/Kimi/Codex 官方接入契约与现有 Harness 的调查。 |
| research-qoder-agent-harness.md | Qoder Agent SDK 接入能力及适配改进调查。 |
| research/codex-cli-protocol.md | Codex TUI 拉起、输入、审批、hook 和状态文件协议速查。 |
| research/kimi-cli-protocol.md | Kimi TUI 的输入、审批、hook 和状态文件协议速查。 |
| research/qoder-cli-protocol.md | Qoder TUI 参数、权限、完成信号与运行状态速查。 |
| research/linux-arm64-ai-tools-support.md | 当时 AI CLI/IDE 对 Linux ARM64 的支持调查。 |
| plan-ahastation-rk3588-overall.md | RK3588 整体硬件、系统、应用栈和风险方案。 |
| checklist-s1-bringup.md | 样机点亮、休眠唤醒、GPU、散热和满栈检查清单。 |
| hackathon-luban-rk3588-bringup.md | LubanCat 黑客松点亮、环境、构建、冒烟与分工方案。 |
| plan-hackathon-s0-concept-demo.md | 三天四人的概念验证 Demo 范围、人员和验收。 |
| research-x86-handheld-devices.md | 首发验证用 x86 掌机和掌上电脑调查。 |
| research/handheld-hackability-report.md | x86 掌机二次开发、Linux 生态和硬件开放度调查。 |
| research/pinephone-pro-lessons.md | PinePhone Pro 的移动 Linux 实践与风险经验。 |
| research/rk3588-odm-factories.md | RK3588/RK3576 手持终端的 ODM、样机及采购调查。 |

## .github/workflows 持续集成

| 文件 | 做什么 |
| --- | --- |
| build-matrix.yml | 在原生 macOS、Windows 和 Linux runner 构建，另在 Debian 11 环境做 ARM64 发布检查；区分普通提交、手工触发和标签发布。 |

## 按功能找到修改入口

| 想理解或修改什么 | 先读哪里 | 后续跟到哪里 |
| --- | --- | --- |
| 启动和窗口 | electron/main.ts、src/main.tsx | preload 文件、对应窗口 IPC。 |
| 主界面布局 | src/App.tsx | components、styles.css、aha-ui.css。 |
| 多项目标签 | src/lib/meeting-store.ts、hooks/useTabs.ts | electron/ipc/sessions.ts、electron/sessions.ts。 |
| 用户消息怎么到 Agent | components/SideDrawer.tsx、hooks/useWorkers.ts | preload.cjs、ipc/session.ts、orchestrator.ts、host-group.ts、相应 backend。 |
| 语音输入 | hooks/useAsr.ts、hooks/useVoiceCapture.ts | ipc/asr.ts、asr/xfyun-iat.ts、lib/voice-final.ts。 |
| 语音输出 | hooks/useTtsWiring.ts | lib/speech-format.ts、speech-session.ts、voice-registry.ts。 |
| 声纹锁 | hooks/useVoiceLock.ts | lib/speaker-embedding.ts、worker、fbank.ts、ipc/settings.ts。 |
| 多 Agent 派任务 | orchestrator.ts、meeting-tools.ts | worker-scheduler.ts、task-*、backends。 |
| 审批 | components/ApprovalCard.tsx | risk-classify.ts、permission-broker.ts、task-authority.ts、auto-approve-policy.ts。 |
| 任务依赖和并发 | worker-scheduler.ts | task-intent.ts、src/lib/dependency-gate.ts、worker-capacity.ts。 |
| 交付审查 | delivery-harness.ts、coordinator-review-driver.ts | delivery-candidate.ts、delivery-diff.ts、delivery-verifier.ts、coordinator-review.ts。 |
| 最终验收与发布 | components/FinalMeetingDelivery.tsx | ipc/meeting-delivery.ts、meeting-delivery.ts、integration-queue.ts、delivery-integrator.ts。 |
| 真终端 Worker | backends/terminal-cli-adapter.ts | 相应 terminal-adapter、pty-host.ts、ipc/worker-pty.ts、components/WorkerWorkbench.tsx。 |
| 独立编辑器 | components/OpenCodeEditor.tsx | ipc/opencode-editor.ts、ide/、ipc/ide-files.ts。 |
| 外部会话观察 | observe/observe-service.ts | process/darwin.ts、statefiles/、mapping.ts、correlate.ts、src/lib/observed-store.ts。 |
| 远端会话 | components/RemoteSessionPicker.tsx | backends/pocket-vibe-target.ts、pocket-vibe-adapter.ts、orchestrator.ts。 |
| 公网配对与身份 | components/RemoteControlSettings.tsx | electron/remote-control.ts、store.ts、resources/remote-service.json；Hub/Bridge 在相邻项目。 |
| 陪伴屏与浮条 | components/CompanionScreen.tsx、AhaBar.tsx | electron/companion/、src/lib/companion/。 |
| 安装包 | package.json、electron-builder.json | scripts/、build/、.github/workflows/build-matrix.yml。 |

## 建议的阅读顺序

1. README.md：先理解产品和会议式协作。
2. package.json、electron/main.ts、src/main.tsx：理解两端启动与构建。
3. src/App.tsx、src/lib/meeting-store.ts、electron/preload.cjs：理解界面、状态与通信。
4. electron/ipc/sessions.ts、electron/sessions.ts、electron/orchestrator.ts：理解一场会议如何创建和运行。
5. electron/host-group.ts、electron/worker-scheduler.ts、electron/backends/cli-backend.ts：理解 Agent 组织与任务执行。
6. electron/task-*、delivery-*、coordinator-review*、meeting-delivery.ts：理解授权、工作区、交付与最终发布。
7. 根据实际关注功能再读语音、编辑器、观察、远端和陪伴屏，配合对应测试理解边界。

部分命名保留历史：window.vibeMeet、AhaMeet、ClaudeWorkspace 和 opencode-editor 不意味着只能支持单一产品或后端。src 与 electron 使用不同 tsconfig，部分类型和纯函数是手动镜像，修改时需要同步并通过两端检查。
