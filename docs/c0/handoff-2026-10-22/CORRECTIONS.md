# 对 Codex 交接包（2026-10-22）的更正

本目录其余文件是 Codex 交接包的原样副本，内容没有修改。下列条目以 `docs/c0/README.md` 为准。

| 原文位置 | 原写法 | 更正 | 依据 |
| --- | --- | --- | --- |
| 交接说明「工作目录与代码基线」；11 架构「基线与复用」；12 WBS「计划基线」 | 主程序源码 `Documents/Claude/AhaStation`，HEAD `bb76522` | 基线是 `ShawnyinsGit/ahastation-internal` main `c134de2`；`bb76522` 是它的祖先，那个检出停在旧分支 `fix/ahabar-hover-drag` | `gh api …/branches/main` 返回 `c134de2…`；`git merge-base --is-ancestor bb76522 c134de2` |
| 交接说明「刚完成的真实基线检查」；`evidence/2026-10-22-baseline-audit.json`；12 WBS 开头 | 888 项：871 通过、16 失败，C0 未通过 | main 上 922 项：921 通过、0 失败、1 跳过。16 个失败在 2026-10-04 已由 `a746051` 和 `f5d88aa` 修复 | `../evidence/2026-10-22-c0-b01-clean-install.json` |
| 交接说明「用 Node22 … 完成下一轮可重复安装验证」 | 尚未进行 | macOS arm64 已完成（干净克隆，Node 22.23.4，npm ci）；Windows 未做 | 同上 |
| 交接说明「源码里 package-lock.json 是用户修改」 | 需保留的用户改动 | 只是根 `version` 字段从 0.17.8 改为 0.18.1，没有依赖变化；仍不要去动那个检出 | `git diff package-lock.json` |
| 交接说明「当前 Orca 工作区……空 initial commit」 | 用作「无项目文件」的依据 | 只适用于 `orca/workspaces/…-internal-2/-3`；`orca/projects/ahastudio` 就是 main 的检出 | `git log` |

产品决定（D01–D64）、规格、架构对象、WBS 结构和语音约束（樱桃 SDK 不支持 N5095）均未更正，继续有效。
