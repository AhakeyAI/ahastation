# 协作评审边界与统一整合

负责人在 [#136](https://github.com/AhakeyAI/ahastation/issues/136) 将第一次合入调整为 [PR #135](https://github.com/AhakeyAI/ahastation/pull/135) 统一整合终端栈、安全基线、协作基线和 C0 文档。原四批仍用于划分代码审查与验收责任，不再据此机械创建四个独立 PR。后续遗留修改按各 Issue 和最终整合结果交付。

已推送的 `etrnal-dev@c584e80` 是修复评审快照。10-30 核对到 main 为 `b571b2c`，PR #135 为 `d358977`，仍是未合入的草稿；整合分支历史尚未包含 `c584e80`。整合前必须核对这笔增量的保留、遗漏与语义冲突，绑定实际 head 给出本方确认，不能沿用旧 head 或把草稿描述中的“已随 #135 合入”视作完成事实。

| 审查边界 | 内容 | 前置与验收 |
| --- | --- | --- |
| 1 契约与正式文档 | contracts/collaboration、contracts/runtime/codex.json、GLOSSARY、ADR 索引、正式说明；契约校验器及其必要依赖和测试 | 与负责人已接受的决定一致；TS/Python 校验一致；三平台 CI、Mac 复核 |
| 2 Hub（C4） | services/remote 的 Hub、鉴权、存储、路由、部署说明及 Python 回归，IF-7 清单转发 | C3；来源授权确认；C6；IF-7 格式确认；本机/内网验证；三平台 CI |
| 3 Station（C5） | electron/collaboration、后端版本门、异步凭据、主进程/IPC 接线、IF-2 归属、IF-4 控制同步、原生载荷及对应测试 | C3/C4；C1/C6、IF-2/4/6；入口关闭零连接；K01/P1/停止/越界回归；三平台 CI |
| 4 界面投影与组件（随 C5） | src 的协作投影、IF-6 受控组件和必要 preload/types；产品接入正式布局 | C5 接线；he-1102 确认接口、产品验收布局；浏览器回归及三平台 CI |

package*.json、electron/store.ts、main.ts、preload、构建/CI 脚本属于共享文件，需同时保留各模块必要的依赖、类型、打包数据及验证，不能整文件选择某一条线的版本。整合后重新验证，原分支的通过数不直接移算到整合版。

排除：runtime、release、冻结安装包、原始日志、私有配置、docs/collaboration/evidence、历史提示词/过程报告、未跟踪的 ROOT_CAUSE_AUDIT 文件。CI 改动保留 #47 的 Windows 修复、上传条件与 7 天保留规则。

IF-6 候选组件和本方接口回复已交付，不等于 he-1102 已确认或 C5 已解除所有前置。C1 的正式前置现为 #136，C3/C4/C5 继续按各 Issue 的依赖推进。U7b 依赖 C5 和 IF-8；IF-8 依赖 Leo 的 IF-5。S6/IF-7 还依赖 IF-3 项目身份。签名/验签、新会话身份与控制接线均有本方实现责任，外部生产者和确认另列，不能全部归为外部阻塞。模拟测试不计为双机验收；正式合入与 PR 操作由负责人流程决定。
