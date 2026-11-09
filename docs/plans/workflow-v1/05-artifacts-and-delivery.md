# 05 共享资料、候选、验收与交付

## 所有权与接口

ArtifactService 管理正文与版本，CandidateService 冻结文件，Verifier 执行检查，DeliveryService 执行用户授权的 Git 与 GitHub 动作。Host 决定分工和是否请求交付，Worker 提供内容与证据，用户对封存的成果版本做最终验收。

复用 delivery-snapshot.ts、delivery-candidate.ts、delivery-verifier.ts、delivery-integrator.ts 和 integration-queue.ts 的已验证逻辑，写入统一事件与状态入口。成果按 workId 归档，操作核对准确的 Worker 和委派版本。旧任务接口只在迁移适配层使用。

写入接口沿用统一幂等信封。成果决定使用 `AcceptWorkResult` 和 `ReturnWorkResult`，PR 核对使用 `RefreshPullRequest`。用户入口与只读差异查询见 06。

## 共享资料

正文对象使用 content hash 定位，logicalPath + version 映射为不可变 Artifact。普通共享目录是可编辑副本，发布入口校验 expectedVersion 后生成新版本。代码之外的报告也须指定依据的提交和资料版本。

publishArtifact 先落正文再写可见元数据，见 02。原始编辑文件变动不会悄悄替换旧版本。允许路径使用规范化相对路径，拒绝越界、符号链接逃逸和系统保留名。正文大小与媒体类型有明确限制，超限返回错误及可用的分块途径。

分析类委派可仅交付 Artifact。`deliveryRequirement=none` 时，技术验证通过后封存成果并提交用户验收。

## 候选冻结

requestFreeze 是异步持久操作，冻结状态保存 requested/quiescing/collecting/published/failed，任一非终态可因用户解除冻结进入 cancelled。执行依据 RuntimeService 的静止证据，暂停用户新输入和 Host 自动输入。可能写入候选路径的后台服务也必须暂停。

适配器无法给出轮次级静止证据时，quiescing 阶段按 01 的冻结降级结束 CLI 进程，以进程树退出作为静止证据，采集完成后再按原生会话恢复。冻结记录注明使用了哪种静止证据。

V1 使用服务管理的私有 worktree。记录基线、允许路径、当前 tracked/untracked 清单、文件类型和范围外改动。使用临时 index，从基线构建候选。按明确的 NUL 分隔文件清单加入新增/修改，并显式移除已删除条目；避免批量暂存混合工作区。Windows 使用 execFile(argv) 和 stdin，路径作为字面值处理。

需要覆盖二进制、删除、重命名后的路径、换行规则、可执行位、symlink 和 Git 子模块条目。子模块内部未提交修改须另列成果或返回不支持，不能声称已被父仓库快照包含。已跟踪但被 ignore 命中的文件仍按跟踪清单处理。

两次采集得到同一树是补充校验，不能替代静止证据。发现变化时保持冻结失败并通知 Host，不自动接受不完整候选。范围外文件不进入候选，保留诊断。

生成 candidateId、tree 与以基线为 parent 的 commit 对象。使用 create-only 的 refs/aha/candidates/<candidateId> 引用固定对象，在数据库登记 exact tree/commit、manifestHash 和冻结证据。临时 index 不写入用户暂存区。

创建引用成功但事务失败时按 candidateId 核对引用与预先保存的 intent；相同内容补登记，内容不一致报 CONFLICT。保留所有已被审查、授权或历史引用的对象，清理需满足留存规则。

候选提交是证据对象：它只被 refs/aha/candidates/ 下的隐藏引用指向，不进入任何分支，也不改变用户可见的提交历史，因此不属于需要用户确认的“提交”。私有工作分支提交与服务交付提交分别记录，界面显示实际行为。需要用户授权的是让目标分支指向新提交的交付动作，规则见总体架构“授权与交付”一章。

## 验证

Candidate 在独立检出目录验证，执行带 argv、cwd、envAllowlist、timeout、expectedExitCodes 和 requiredArtifacts 的检查。禁止把模型提供的 shell 文本直接拼接为命令。确需 shell 的检查显式保存 shell 类型和完整脚本。

验证脚本属于仓库执行代码，使用与 Worker 同等级的权限和凭据档案，由独立检查进程执行。交付进程所持有的推送凭据不得注入检查进程。当前用户环境的防误操作限制仍然适用，不能因脚本由服务启动就将其视为可信。

验证前后核对 Candidate 中的文件清单、内容、模式及子模块引用。测试或 formatter 修改了候选源文件时，本次结果标为 CHECK_MODIFIED_SOURCE，交给 Worker 形成新候选并重新验证。允许的构建产物记录在显式输出目录中，不能覆盖候选源文件。检查失败保留实际检出目录和差异证据。

Verification 绑定 workId、委派版本、specHash、candidate tree/Artifact hash、检查定义 hash 与环境摘要。缺少检查、退出未知、日志不完整、必需产物缺失均不得记为通过。报告 passed 字样是 Worker 声明，服务验证另有身份。

重型验证申请 exclusive 租约，实际开始前核对占用。验证期间超时先停止并确认检查进程退出，再释放租约。独立审查使用 Host 指定的另一个 Worker，结果绑定准确 Candidate；只有要求的所有机器与 Host 判定均通过才 verified。

文件变化使对应验证失效。等待交付授权时若内容与依赖未变，保留有效验证并直接继续服务交付，不唤醒 Worker重复实现。

## 成果封存与用户验收

`deliveryRequirement` 取 `none`（仅成果）、`git`（指定 Git 交付）或 `github_pr`（指定远端分支交付并关联真实 PR）。所有要求通过后，服务为同一 workId 分配递增的 `resultVersion`。WorkResult 固定委派、候选及资料版本、验证记录、交付回执和所需 PR 快照。要求 PR 时，封存事务核对快照属于当前 Delivery。封存、结束本次委派和进入 `awaiting_acceptance` 在同一事务完成。

用户界面提交 `AcceptWorkResult` 或 `ReturnWorkResult`，携带 `workId`、`resultVersion`、`expectedWorkRevision`，退回附原因。服务核对本机用户身份、权限、当前待验收版本和工作 revision，并在同一事务写入唯一的成果决定、工作状态和通知事件。命令重放复用原回执；同一版本已作决定或有新版时拒绝相反决定和过期操作。Host 判定与机器检查提供技术证据，用户结构化决定才推进 `completed`。接受动作只更改工作状态，提交、推送、创建 PR 和合并分别按动作授权。

退回后保留已发生的 Git 和 PR 事实。Host 按同一 workId 重新排队，后续提交新成果版本。PR 交付的接受操作还须按本章“GitHub PR 绑定与差异快照”重新核对所阅快照。

## Delivery 数据与状态

Delivery 保存 id、requestId、workId、worker/version、candidateId、specHash、deliveryMode、targetRepository、targetRef、expectedTarget、deliveryCommit N、提交信息、Grant IDs、localResult、remoteResult 和操作记录。`expectedTarget` 是明确的 `present(T)` 或 `absent`。Candidate 的基线 `C` 单独保存。PR 交付另存 head 归属、拟议 base ref、选定的既有 PR（如有）、PR 绑定与阻断原因。当前候选的首次 PR 申请登记 `currentPrDeliveryId`，同一候选换分支时经授权切换指针，新记录保存 `replacesDeliveryId`。新委派或新候选重新登记指针，旧回执按原 Delivery 保存。

deliveryMode 有三种：

| 模式 | 行为 | 典型用途 |
|---|---|---|
| remote-branch | 直接把 N 推送到远端分支，已存在时普通快进，首次推送时按 `absent` 条件创建 | 推送功能分支、GitHub PR 的 head 分支 |
| local-ref | 只更新本地目标分支 | 本地集成，不推送 |
| local-and-remote | 先更新本地目标分支，再推送 | 直接交付到共享分支 |

状态为 requested → awaiting_grant → prepared → updating_local → local_applied → pushing → verified。remote-branch 模式从 prepared 直接进入 pushing；local-ref 模式在 local_applied 后直接进入 verified。分支包括 needs_reintegration、uncertain、failed、cancelled。每个外部操作前先写 intent，后写 receipt。取消只能取消尚未发生的操作，已经发生的提交或推送作为事实保留。

提交和推送分别授权。Grant 绑定准确 Candidate、目标引用与预期存在状态、提交信息和动作，推送还绑定 N。服务执行前及外部操作开始前检查撤销和过期。`Delivery.verified` 表示对应 Git 步骤已核对，要求 PR 时继续核对 PR 与差异快照。

## GitHub 远端分支归属

PR 交付默认使用 `refs/heads/aha-pr/<workId>` 作为专用 head，首次使用按 `absent` 创建。同一工作返工可复用已登记的 head。用户也可以在推送授权中选定已有分支。服务先核对该分支的实际 SHA 和以它为 head 的开放 PR，查询涵盖所有 base。已有开放 PR 时，推送授权须明确关联预期 PR 编号和 base ref。若同一 head 上还有其他开放 PR，或已有其他工作归属，交付提示改用独立分支。PR 的 head 与 base 分别校验且必须不同。

服务以 GitHub 实例、head 仓库 ID 和规范 `refs/heads/...` 作为归属及推送租约的键。已登记的仓库别名解析到同一 ID，实际推送地址须与登记的仓库身份一致。申请时核对归属，推送授权绑定该键及准确提交。确认 PR 交付的推送授权时，服务在事务中核对目标归属和在途推送，再登记本工作对 head 的预留。写入已有 PR head 前重新查询远端引用和开放 PR，并核对授权时的目标。进入 `dispatching` 的事务再次校验归属、Grant 和当前 Delivery，再取得推送租约。所有通过服务发起的 GitHub 推送共用这把租约和归属检查，包括仅交付 Git 分支的推送。对归属其他 `workId` 的分支，在远端写入前返回 `REMOTE_HEAD_OWNED`。仓库身份无法核对时，推送保持待核对。

结果不明的推送保留目标占用并先核对。已写入或已绑定 PR 的 head 持久归属原工作，覆盖待验收、退回、取消及改派。仅当确认相关操作均已结束且未产生远端写入或绑定时，才可撤销预留。该规则约束 WorkflowService 的写入。外部 Git 操作由交付后核对和验收前刷新发现。

## 条件交付

1. 核对目标引用并保存授权申请。已存在时记 `present(T)` 并校验 `C == T`。仅 `remote-branch` 支持 `absent`，要求经认证的远端查询明确该 ref 不存在。网络错误和权限错误保留待核对。首次推送采用已核对的 Candidate 基线 `C`，PR 的目标 base 分支另行核对。
2. 已存在目标与 `C` 不相等时返回 needs_reintegration，由 Host 指定 Worker 在 T 上重新集成并生成新候选，重新验证与确认。首次推送遇到另一方创建目标时按原预期 `absent` 处理冲突，改用已存在分支需要重新确认。
3. 固定作者、提交者、时间与信息，生成以 `C` 为父提交、Candidate.tree 为树的 N。把全部元数据与 N 写入 intent，使重试可复现相同对象。
4. 仅 local-ref 与 local-and-remote 模式执行第 4、5 步。更新引用之前，按仓库 git-common-dir 与目标 ref 获取应用内操作租约，检查所有 worktree 的检出占用。目标未被检出时进入第 5 步。目标正被某个 worktree W 检出时：
   - 授权包含“更新已检出的工作区”，且 W 满足下面全部条件时，在 W 中执行 `git merge --ff-only --no-overwrite-ignore N`。git 的 merge 默认会静默覆盖被忽略的文件，`--no-overwrite-ignore` 让它在这种情况下中止；git 默认也拒绝覆盖未跟踪文件。这两项都只是第二道防线，前置检查才是主要依据：
     - 分支等于 T；已跟踪文件无改动、无暂存（`git status --porcelain=v2 -z --untracked-files=no` 为空）。
     - 用 `git diff --name-only -z --no-renames T N` 得到本次会写入或删除的路径，再加上这些路径的各级父目录。在 W 中，这些路径上不能存在未跟踪或被忽略的文件或目录（`git ls-files --others -z` 不加 `--exclude-standard`，同时覆盖被忽略的文件，按上述路径限定范围并使用字面路径匹配），也不能有文件与目录类型互换的冲突。
     - 这些路径在 index 中没有 assume-unchanged 或 skip-worktree 标记（用 `git ls-files -v -z` 检查）。带这两种标记的文件，git status 可能看不到本地改动。
     - 在大小写不敏感的文件系统上，按卷的大小写规则比较路径，避免仅大小写不同的路径互相覆盖。
     - 合并完成后核对：分支等于 N；已跟踪文件仍然干净；合并前记录的未跟踪和被忽略文件的大小、修改时间和哈希均未改变。核对失败时进入 uncertain 并保留现场，不自动回退。
   - W 有改动、分支不等于 T、前置检查发现冲突或授权不包含该动作时，返回 TARGET_IN_USE，引用保持原值，保存待处理交付，界面列出 W 的路径和改动摘要，并提供改用 remote-branch 或交付到未检出分支的途径。
   - 检查占用和实际更新之间不执行其他慢操作。
5. 占用检查通过后，更新本地目标引用并比较旧值 T。若已为 N，核对本次 Delivery 的 intent 及提交内容后补成功回执；其他值返回 BASE_MOVED。操作完成后释放引用租约。
6. 有独立推送授权并通过适用的远端分支归属检查后，在服务私有的裸仓库按准确 `N:refs/heads/<branch>` 推送，成功、拒绝、网络结果不明分别记录。`present(T)` 只做普通推送。`absent` 使用明确的空预期值 `--force-with-lease=refs/heads/<branch>:`，只允许创建此引用，目标被其他提交占用时返回 BASE_MOVED。
7. 查询远端并核对结果。已存在分支的普通 Git 交付可以记录确认包含 N 的后继提交和 `observedHead`。首次推送只核对准确 N，结果不明后若目标仍不存在，仅按原 N 和空预期值重试。发现 N 已存在时记录实际观测，区分本次创建的回执与已到达目标的事实。要求 GitHub PR 时，只有 `observedHead == N` 才继续绑定 PR，后继提交保留为 Git 事实并提示重新核对。

普通推送能拒绝远端已经前进产生的非快进覆盖。远端回退到 T 的祖先时，普通推送仍可能快进，既有分支依赖发布前核对和分支管理约束。首次创建的空预期值是唯一使用 lease 的路径。既有分支的严格条件更新需另行设计和授权。[Git push 的显式预期值](https://git-scm.com/docs/git-push)

本地更新成功而推送失败时保留 local_applied，不退回原本地 ref。重新集成产生新 Delivery 记录，旧记录指向替代项。纯本地交付完成即可 verified；资料类不创建 Delivery。

应用内引用租约覆盖同一仓库的不同 worktree 和不同工作流。外部 Git 进程不会遵守该租约，因此执行前后都核对引用及占用证据，V1 对检测到的外部并发返回待核对；不能承诺阻止任意外部进程在检查间隙 checkout。常见已占用主分支可以先交付到服务管理的未检出分支，再由用户授权的后续集成处理目标工作目录。

Grant 与 Delivery 的取消按 02 的 dispatching 边界处理。撤销时已经发生的外部操作记录为事实，后续推送或其他尚未开始的步骤立即停止。

Git 的条件引用更新按 old-oid 核对。[Git update-ref](https://git-scm.com/docs/git-update-ref)

## GitHub PR 绑定与差异快照

V1 支持同一 GitHub 仓库内的 head 与 base。`remote-branch` 负责推送 head，PR 的 base 分支单独指定。交付服务复用基线 `electron/collaboration/github.ts` 的仓库认证和查找／创建入口，将只返回 URL 的契约扩为结构化回执。服务从用户登记的仓库和允许的 GitHub API 地址构造请求，API 凭据只在主进程使用。PR 正文、路径及 Diff 均作为不可信内容呈现。

1. 推送核对准确 N 后，在已归属的 head 上核对 PR。已有选定编号时直接按编号获取详情，否则按仓库 ID、head ref、base ref 查找后读取详情。只复用匹配仓库、分支及 `head.sha == N` 的开放 PR。一个 PR 归属一个 workId，同一工作返工时可复用。已经绑定的 PR 若在外部合并，保留该事实，并按同一身份核对其最后交付版本。遇到不匹配、已关闭未合并或归属冲突，保存 Git 回执及 PR 阻断原因。
2. 需要创建时由用户单独授权，Grant 绑定 workId、Candidate、N、仓库、head/base ref 与标题正文。按 PR 目标元组持久化占用，在 POST 前写入 intent、再次查找并核对远端 head，外部操作开始事务校验当前 Delivery 和 head 归属。POST 成功或响应不明时先按原意图查 PR 编号及实际身份，匹配才补回执。查不到且无法确定 POST 未执行时保持 `uncertain` 和原目标占用，其他请求也须先核对。创建期间 head 变化时记录实际 PR 和冲突，由用户核对。
3. 按编号读取真实 PR 的身份、URL、状态、base/head 的仓库 ID、ref、SHA 和变更统计。两次详情读取之间取一次 GitHub PR Diff 响应（`Accept: application/vnd.github.diff`），前后核对 PR 元数据、变更统计及更新时间一致。按文件拆分同一响应，核对文件数、增删行总数及每个补丁分块的完整性，保存观察时间、SHA 与正文哈希。GitHub 的 PR Diff 按 PR 编号读取，这组独立请求提供当时的观测证据，外部推送仍可发生在观测之间或之后。界面按快照分页并显示核对时间。GitHub PR 与本地比较可能采用不同基线，Candidate Diff 作为独立证据展示。[读取 GitHub PR 与 Diff](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) · [GitHub 的比较基线](https://docs.github.com/en/pull-requests/reference/pull-requests#differences-between-commits-on-compare-and-pull-request-pages)
4. 快照的文件索引保留状态、新旧路径、统计及文本 patch，二进制或纯模式变化使用相应类型提示。API 截断、版本核对失败、权限不足或无法证明文件清单完整时，显示对应原因和真实 PR 链接，并保持 PR 交付待核对。原快照可查，最新读取的页按 snapshotId 分开缓存。
5. 进入 PR 成果视图时可以刷新。用户接受前按步骤 3 重新获取 PR 和 Diff，计算摘要并与该 WorkResult 的快照身份、状态、base/head 和 Diff 哈希核对。外部读取在事务外进行，回写时再次核对 `workId + resultVersion + expectedWorkRevision`，接受决定记录本次观察时间和快照。服务核对到 PR 变更时，事务标记旧版过期并增加 Work revision，之前开始的接受请求和慢响应按旧 revision 拒绝。相同 head 且已核对新快照与受影响的验证时可封存新成果版本，head 不再等于 N 时由 Host 根据用户退回安排返工。已验收后出现的 PR 变化作为新事实显示，保留原验收依据。

## 首次 PR 交付受阻后的恢复

Git 推送已核对而首次 PR 创建结果待核对、已关闭未合并、head 变动或 Diff 暂不可用时，记录当前 Delivery 的 PR 阻断原因及实际回执，工作保持 `in_progress`。恢复操作使用 `workId` 和当前 `deliveryId`，此时成果封存仍待完成。

- **重新核对**。`RefreshPullRequest` 可在 PR 尚未绑定时按已有推送和 PR 创建意图查询，也可重读已知 PR 的状态及 Diff。它对远端只读。证据齐备且 Delivery 仍为当前记录时，服务按正常条件封存 WorkResult，已完成的 Worker 轮次可直接沿用。结果仍不明的创建操作继续按原意图核对。
- **换分支重新交付**。Host 通过 `RequestDelivery` 提交 `replacesDeliveryId`、`expectedWorkRevision`、原 Candidate 和不同 head。若候选及验证仍有效，可直接生成新的交付申请。需要修改候选时，在同一 `workId` 下修订并验证。新分支按归属及条件推送规则核对，使用自己的提交、推送和 PR 创建授权。

用户确认新推送授权时，服务在同一事务核对工作版本、旧记录仍是受阻的当前 Delivery 以及新 head 可登记，预留新 head 后切换 `currentPrDeliveryId`，撤销旧交付尚未开始的写入步骤并保存新意图。已发生的推送、已创建的 PR 和结果不明的操作留在旧记录中，可继续只读核对。迟到结果只补充原 Delivery 的事实。只有当前 Delivery 的有效 PR 快照可用于该工作首次封存成果。已封存成果的更新和退回按用户验收规则处理。

## 凭据与隔离

V1 为 Worker 提供专用 Git 环境和常规命令防误操作入口。仓库级 credential.helper 的优先级和 SSH 私钥可能绕过单纯清空全局配置，因此必须对每种常规推送路径做负向测试，并准确展示防护覆盖。

需要阻断通常的 git push 时，可用受控 PATH 的 Git 入口对 push 返回待服务授权，其他命令转发到绝对路径 Git。服务使用独立入口和用户已授权凭据。该入口在当前用户权限下仍可被绝对路径、gh 或脚本主动绕过，不能当作强隔离。

保持原生模型登录能力与 Git 凭据边界分别配置。强隔离不属于 V1。真实推送验证仅使用已授权的测试远端和一次性分支，禁止向用户业务分支做试验。

### 服务端 Git 调用的加固

同一仓库的所有 worktree 共享 .git 公共目录，Worker 对其中的 config 和 hooks 有写权限。服务执行的 Git 命令如果读取这些内容，就会把 Worker 的写入变成以服务身份运行的代码，或者把推送改写到其他地址。可被利用的配置包括：hooks（pre-push、post-merge、reference-transaction 等，`update-ref` 也会触发 reference-transaction）、`core.fsmonitor`、`core.sshCommand`、`core.askPass`、`credential.helper`、`url.<base>.insteadOf` 与 `remote.<name>.pushurl`，以及 clean/smudge 过滤器。规则：

1. **凭据只在服务私有的裸仓库中使用**。每个目标仓库在 userData 下有一个由服务创建、Worker 无写权限的裸仓库。交付时从 Worker 仓库获取 Candidate 的隐藏引用（`git fetch <仓库路径> refs/aha/candidates/<candidateId>`，按引用获取，不依赖源仓库允许按任意对象 ID 获取），核对提交与树的对象 ID；再按第 3 步固定的元数据在私有裸仓库中生成 N，然后从这里推送。local-ref 与 local-and-remote 模式在 Worker 仓库中用同样的元数据生成 N，并核对两边的对象 ID 相同。远端 URL 在登记仓库时由用户确认并保存在服务中，推送时显式给出，不读取 Worker 仓库的 remote 配置。
2. **在 Worker 可写的仓库中执行的 Git 命令不持有凭据**。候选采集、`update-ref`、已检出工作区的快进合并等操作，使用与 Worker 相同的、不含推送凭据的环境运行。
3. **服务的所有 Git 调用禁用 hooks 和 fsmonitor**：`-c core.hooksPath=<服务管理的空目录>`、`-c core.fsmonitor=false`。过滤器（如 Git LFS）在已检出工作区中仍然需要运行才能得到正确文件，它们在第 2 条的无凭据环境中运行。
4. 用户需要 post-merge 等钩子的效果时，由用户在自己的终端中执行，服务不代为运行。

## 验收

DL-01 新增/删除/二进制快照准确；DL-02 冻结期间后台写入拒绝；DL-03 两 Worker 候选引用不冲突；DL-04 候选引用创建后崩溃可恢复；DL-05 验证失败不完成；DL-06 授权后内容改变拒绝交付；DL-07 目标前进需重新集成；DL-08 本地更新后断网不重复提交；DL-09 推送成功回执丢失可核对；DL-10 目标在有改动的 worktree 中检出时返回 TARGET_IN_USE；DL-11 无 Git 的报告等待并获得用户验收；DL-12 子模块脏内容明确处理；DL-13 目标在干净 worktree 中检出且已授权时快进成功，工作区文件同步更新；DL-14 remote-branch 模式不改本地引用，远端前进时推送被拒并进入 needs_reintegration；DL-15 冻结降级为结束进程后采集，记录静止证据类型；DL-16 目标路径上存在被忽略或未跟踪的本地文件时拒绝快进，文件保持不变；DL-17 目标路径带 assume-unchanged 或 skip-worktree 标记时拒绝快进；DL-18 Worker 在 .git/hooks 植入 pre-push 和 reference-transaction 钩子、在 .git/config 改写 pushurl 和 credential.helper 后，服务交付时钩子不执行，推送仍到达用户确认的远端，凭据不暴露给仓库配置指定的程序。

DL-19 首推新分支、并发创建同名分支和回执丢失均按 `absent` 意图核对；DL-20 PR 创建回执丢失按原意图查到同一编号，无明确结果时不重发；DL-21 真实 PR 逐文件 Diff 与 Candidate 各自可查，Diff 缺失或变版时暂停验收；DL-22 退回或重复验收保留旧成果、用户决定及原有远端事实。

DL-23 其他工作无论选择 PR 还是普通 Git 推送，在写入前均被分支归属拦截。DL-24 首次 PR 交付受阻可重读原意图，或经重新授权换分支。旧操作的迟到结果留在原记录，当前交付才可封存成果。
