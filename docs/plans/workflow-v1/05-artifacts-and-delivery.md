# 05 共享资料、候选、验收与交付

## 所有权与接口

ArtifactService 管理正文与版本；CandidateService 冻结文件；Verifier 执行检查；DeliveryService 执行用户授权的 Git 副作用。Host 决定分工和是否请求交付，Worker 提供内容与证据。

复用 delivery-snapshot.ts、delivery-candidate.ts、delivery-verifier.ts、delivery-integrator.ts 和 integration-queue.ts 的已验证逻辑，写入统一事件与状态入口。新工作流以 Worker 和委派版本定位，旧任务接口只在迁移适配层使用。

接口为 publishArtifact、requestFreeze、getCandidate、runVerification、recordHostVerdict、requestDelivery、authorizeDelivery、executeDelivery、reconcileDelivery。每个接口均使用统一幂等信封。

## 共享资料

正文对象使用 content hash 定位，logicalPath + version 映射为不可变 Artifact。普通共享目录是可编辑副本，发布入口校验 expectedVersion 后生成新版本。代码之外的报告也须指定依据的提交和资料版本。

publishArtifact 先落正文再写可见元数据，见 02。原始编辑文件变动不会悄悄替换旧版本。允许路径使用规范化相对路径，拒绝越界、符号链接逃逸和系统保留名。正文大小与媒体类型有明确限制，超限返回错误及可用的分块途径。

分析类委派可仅交付 Artifact。验证通过且 deliveryRequirement=none 时，服务直接把委派推进到 done。

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

Verification 绑定 Worker、specHash、candidate tree/Artifact hash、检查定义 hash 与环境摘要。缺少检查、退出未知、日志不完整、必需产物缺失均不得记为通过。报告 passed 字样是 Worker 声明，服务验证另有身份。

重型验证申请 exclusive 租约，实际开始前核对占用。验证期间超时先停止并确认检查进程退出，再释放租约。独立审查使用 Host 指定的另一个 Worker，结果绑定准确 Candidate；只有要求的所有机器与 Host 判定均通过才 verified。

文件变化使对应验证失效。等待交付授权时若内容与依赖未变，保留有效验证并直接继续服务交付，不唤醒 Worker重复实现。

## Delivery 数据与状态

Delivery 保存 id、requestId、worker/version、candidateId、specHash、deliveryMode、targetRepository、targetRef、expectedTarget T、deliveryCommit N、提交信息、Grant IDs、localResult、remoteResult 和操作记录。

deliveryMode 有三种：

| 模式 | 行为 | 典型用途 |
|---|---|---|
| remote-branch | 不更新本地引用，直接把 N 普通推送到远端分支；T 取自刚获取的远端分支 | 推送功能分支、走合并请求流程 |
| local-ref | 只更新本地目标分支 | 本地集成，不推送 |
| local-and-remote | 先更新本地目标分支，再推送 | 直接交付到共享分支 |

状态为 requested → awaiting_grant → prepared → updating_local → local_applied → pushing → verified。remote-branch 模式从 prepared 直接进入 pushing；local-ref 模式在 local_applied 后直接进入 verified。分支包括 needs_reintegration、uncertain、failed、cancelled。每个外部操作前先写 intent，后写 receipt。取消只能取消尚未发生的操作，已经发生的提交或推送作为事实保留。

提交和推送分别授权。普通模型消息不能产生 Grant。Grant 绑定准确 Candidate、目标 T、提交信息和动作。服务执行前及外部操作开始前检查撤销和过期。

## 条件交付

1. 获取 T 并保存授权申请，校验 Candidate.baseCommit == T。
2. 不相等时返回 needs_reintegration，由 Host 指定 Worker 在 T 上重新集成并生成新候选，重新验证与确认。
3. 固定作者、提交者、时间与信息，生成以 T 为父提交、Candidate.tree 为树的 N。把全部元数据与 N 写入 intent，使重试可复现相同对象。
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
6. 有独立推送授权后按准确 N:targetRef 普通推送，成功/拒绝/网络结果不明分别记录。推送在服务私有的裸仓库中执行，不在 Worker 可写的仓库中执行，规则见“服务端 Git 调用的加固”。
7. 查询远端并核对 N 的存在。远端已为 N 或在确认包含 N 的后继提交时记录已交付及 observedHead；其他情况保留 uncertain，禁止直接重做 Worker 或盲目推送。

普通推送能拒绝远端已经前进产生的非快进覆盖。远端被其他人回退到 T 的祖先时，普通推送并不能保证“只在恰好 T 时更新”。V1 禁止服务 force，发布前复核且依赖远端分支管理约束；不能宣称任意外部 ref 变化都有严格 CAS。若产品要求严格远端 T 条件更新，应单独评审显式 lease 或服务端条件接口，其授权及后端支持不能悄悄替换普通推送语义。

本地更新成功而推送失败时保留 local_applied，不退回原本地 ref。重新集成产生新 Delivery 记录，旧记录指向替代项。纯本地交付完成即可 verified；资料类不创建 Delivery。

应用内引用租约覆盖同一仓库的不同 worktree 和不同工作流。外部 Git 进程不会遵守该租约，因此执行前后都核对引用及占用证据，V1 对检测到的外部并发返回待核对；不能承诺阻止任意外部进程在检查间隙 checkout。常见已占用主分支可以先交付到服务管理的未检出分支，再由用户授权的后续集成处理目标工作目录。

Grant 与 Delivery 的取消按 02 的 dispatching 边界处理。撤销时已经发生的外部操作记录为事实，后续推送或其他尚未开始的步骤立即停止。

Git 的条件引用更新按 old-oid 核对。[Git update-ref](https://git-scm.com/docs/git-update-ref)

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

DL-01 新增/删除/二进制快照准确；DL-02 冻结期间后台写入拒绝；DL-03 两 Worker 候选引用不冲突；DL-04 候选引用创建后崩溃可恢复；DL-05 验证失败不完成；DL-06 授权后内容改变拒绝交付；DL-07 目标前进需重新集成；DL-08 本地更新后断网不重复提交；DL-09 推送成功回执丢失可核对；DL-10 目标在有改动的 worktree 中检出时返回 TARGET_IN_USE；DL-11 无 Git 的报告可完成；DL-12 子模块脏内容明确处理；DL-13 目标在干净 worktree 中检出且已授权时快进成功，工作区文件同步更新；DL-14 remote-branch 模式不改本地引用，远端前进时推送被拒并进入 needs_reintegration；DL-15 冻结降级为结束进程后采集，记录静止证据类型；DL-16 目标路径上存在被忽略或未跟踪的本地文件时拒绝快进，文件保持不变；DL-17 目标路径带 assume-unchanged 或 skip-worktree 标记时拒绝快进；DL-18 Worker 在 .git/hooks 植入 pre-push 和 reference-transaction 钩子、在 .git/config 改写 pushurl 和 credential.helper 后，服务交付时钩子不执行，推送仍到达用户确认的远端，凭据不暴露给仓库配置指定的程序。
