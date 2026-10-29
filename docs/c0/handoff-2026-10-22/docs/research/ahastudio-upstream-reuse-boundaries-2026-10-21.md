# AhaStudio 上游复用边界核对（2026-10-21）

本轮为产品 grilling 的研究笔记，不是架构选型或实施批准。先阅读了既有 `paseo-multica-comparison-2026-10.md` 和 `orca-ade-v1.4.218-comparison.md`，随后核对官方当前 README、许可证、包声明和接口文档。写前检查目标目录及所有祖先，未发现 AGENTS.md。本轮没有安装、运行或修改任何上游项目；未验证 AhaStation N5095 真机性能、Windows/Linux 行为、中文语音、断网恢复或批准安全。GitHub commits API 返回 403 限流，未固定当前 main SHA；本文 main 链接是查阅日期的移动来源，不能当可复现锁定版本。既有报告固定的旧 SHA/标签只代表旧研究。

## 判断

AhaStudio 应自持“谈话怎样成为决定、任务、授权、交付”的产品语义，同时优先评估外部运行底座。**Paseo 已有真正面向外部开发者的 TypeScript SDK 与 daemon/CLI，值得成为第一个 adapter 验证候选；这不等于已选定它，也不意味着要 fork 整个产品。** Orca 更适合作为运行模型参考与现有用户的可选 CLI adapter；Multica 的 Issue/Run/Squad 值得参考，但现有许可和默认权限机制使它不宜未经进一步安排就作为 Aha 商业内嵌底座。

## Paseo：有公开 SDK，优先验证服务边界

官方 README 明确展示 `@getpaseo/client`、`createPaseoClient`，通过 WebSocket 连接 daemon 后创建 Agent；CLI 文档也说明命令对应 daemon API。包声明存在公开根导出，另有明确带 `internal/` 的导出路径，Aha 不应把后者当稳定业务接口。[README](https://github.com/getpaseo/paseo/blob/main/README.md)、[CLI](https://paseo.sh/docs/cli)、[client manifest](https://github.com/getpaseo/paseo/blob/main/packages/client/package.json)

SDK 文档覆盖 Agent 创建、follow-up、按 ID 继续、父子关系、后台 workspace 与结构化输出。这些足够支持“Host 通过 adapter 调用已有运行服务”的原型；会话重启保留不等于进程和外部副作用安全自动恢复。`waitForFinish()` 可能返回 permission、error 或 timeout；timeout 并不取消 Agent。不能将返回 idle 或最后一条模型消息当作任务已验收。[SDK Agents](https://paseo.sh/docs/sdk/agents)

事件文档明确重连不会自动补放漏掉的历史。调用方需按 epoch/sequence 拉取历史并对账；完成应看 turn 事件，而非只看 Agent 状态转为 idle。这说明 Aha 仍需维护自己的执行映射和恢复逻辑，不能只接一个实时订阅就认为任务事实可靠。[SDK Events](https://paseo.sh/docs/sdk/events)

权限是候选验证的硬门槛：Paseo 支持传递 provider-native options，但 provider 各自解释；其文档警告 provider 配置并非宿主隔离。Codex 的 `approval_policy: never` 只关闭提示；若未另配 sandbox，可能成为无人值守全访问。Claude 可配置自身 sandbox。Antigravity 则只有 full access，无法在被外部驱动时提问批准，且 steering/MCP 不齐。因此不能把“支持 provider”当“权限保真”。[Provider options](https://paseo.sh/docs/sdk/provider-options)、[Supported providers](https://paseo.sh/docs/supported-providers)

建议优先使用公开 SDK 根入口连接独立 daemon，CLI 作诊断和必要的兼容路径；先验证一个 provider，再扩到第二个。仍待验证：批准请求的精确数据与回复接口、请求过期/重放防护、停止后的子进程与外部动作、版本兼容、重连事件去重，以及插件或 provider 是否会绕过 Aha 授权。无法保真的 provider 应降级为观察/人工操作，不能包装成受控自动派工。

Paseo 主体 LICENSE 是 Apache-2.0，第三方组件保留各自许可。源码复用、分发与模型资产仍需逐项保留对应条件，不能只看根 package 字段。[LICENSE](https://github.com/getpaseo/paseo/blob/main/LICENSE)

## Orca：完整运行产品，可选 adapter，勿把内部模块当 SDK

官方 README 显示它是完整多 Agent 工作台，围绕终端、worktree、审阅和远程操作组织。Orchestration 文档公开 CLI 的 Run/Task/Dispatch、消息和 decision gate，但仍标 Experimental，并要求已运行 Orca runtime。Run 是 namespace/inbox，本身不调度；旧命令已有退役记录。因此它是可脚本化产品能力，不足以推断为独立稳定运行库。[README](https://github.com/stablyai/orca/blob/main/README.md)、[Orchestration](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/cli/orchestration.mdx)

可借鉴 Task/Dispatch 分离、过期完成报告防护、消息确认、worker 释放与 gate。对已经在 Orca 工作的用户，可评估 CLI adapter；若抽取内部运行模块，Aha 就需自行承担其依赖、迁移和升级，不应称为“直接依赖稳定 SDK”。本次未找到面向第三方、与完整产品解耦的稳定 SDK 承诺。

根 LICENSE 当前为 MIT；复用时仍应核查所用文件、依赖及 NOTICE，而非认为整个依赖树同为 MIT。[LICENSE](https://github.com/stablyai/orca/blob/main/LICENSE)

## Multica：参考任务组织，不预设可直接商业嵌入

官方 README 给出 Web/Electron/iOS → Go backend → PostgreSQL → 本地 Agent daemon 的运行形态，也提供 CLI/API，围绕 Issue、Run、Squad、review 工作。适合研究团队分派与异步进展；API 可调用不等于它是可替换的轻量 runtime SDK。[README](https://github.com/multica-ai/multica/blob/main/README.md)

LICENSE 不是纯 Apache-2.0，而是 Part I 附加条件与 Part II 合成的 Multica License：未取得商业许可时，对第三方托管服务、商业产品/服务中的嵌入有限制；另有 UI 品牌保留和非 UI 使用归属要求。这里记录原文实质，不对 Aha 某一具体发布方式作法律结论。**未经相应许可安排，不应把 Multica 源码直接列入商业内嵌的已定技术方案。**[LICENSE](https://github.com/multica-ai/multica/blob/main/LICENSE)

其安全文档明确默认 daemon 用户权限即运行权限，默认 Codex full access、Claude bypassPermissions，批准自动回答；隔离建议放在独立用户、容器或 VM。这个默认机制不满足 Aha 已讨论的“任务级授权，越界暂停”承诺。若将其作为可选外部任务系统连接，也必须分别明确事实源、可见权限与执行边界。[Security model](https://github.com/multica-ai/multica/blob/main/apps/docs/content/docs/security-model.mdx)

## Aha 自持与上游复用的分工建议

| 自持的产品契约 | 优先复用或适配的运行能力 |
| --- | --- |
| 发言原文、来源和讨论/决定/待确认的区别 | ASR/TTS provider、音频传输 |
| Host 邀请谁发言、何时打断、保留一线异议 | 原生 Harness 的会话、工具调用和模型能力 |
| TODO 与正式执行的区别、阶段口头确认 | Agent 创建、发送、状态、历史、停止/续跑 |
| 任务范围、授权版本、风险升级与成员暂停规则 | 已有 sandbox 和批准通道，但必须验证能力 |
| 项目决定、任务依赖、验收标准与接受记录 | worktree、进程管理、Git/Diff 与产物获取 |
| 通勤状态、对话目标、手持/接屏连续体验 | daemon、连接与已有重连原语 |

这是职责判断，不意味着每一项都要新写底层代码。实现优先顺序应是公开接口依赖、薄 adapter、必要且边界清楚的源码移植，最后才考虑整产品 fork。多个项目的 Skill 可借鉴流程，但 Skill 是给模型的操作说明，不等同于可持久化、可强制执行的运行服务；同理，Host 的提示词不能替代授权状态机。

下一步若决定开展技术验证，应把 Paseo adapter 与现有 AhaStation 实现放到相同的最小任务上比较：创建/追问、批准/拒绝、停止、重连补历史、重启恢复、越界请求、证据返回。以结果决定复用，不以支持 CLI 数量或代码规模决定。未通过前，仍是候选。
