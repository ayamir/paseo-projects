# 线程 resolve 后的清理

线程 resolve 时自动清理它留下的东西。只删能确认属于这个线程、并且确实可以丢掉的东西；拿不准就保留，并写下原因。

已登记工作副本按资源检查回收；下面的旧清理流程仅保留为明确指定历史线程时的兼容行为，不代表接管。针对未接管的旧 Git worktree / OVNFS 线程，ticker 可以记录线程完成，但不会清理、归档其工作区或删除分支。

## 归属规则（只有这一条）

先检查完、列出索引，最后才删：

- 能删的只能是一个真实路径，并且在删任何东西之前就解析好。它必须在本线程自己的目录里，或者在 `<tmp>/<id>-…` 下。
- 它不能碰任何线程目录：不能是线程目录、不能是线程目录的祖先、不能装着线程目录，只能在本线程目录的内部。
- 它不能和任何声明保留的路径重叠，祖先和子孙都算。
- 一个索引属于本线程，只有两种情况：它的根在删除前就解析到本次删掉的路径里；或者本线程之前的清理记录里登记过它删除失败（名字和根都要对上）。重试时，它的根现在解析出的真实路径必须和当时记录的一致，当时证明归属的那个已删目录也必须仍然不存在；路径被重新占用或改指向（例如变成指向主 checkout 的链接）就保留，旧记录没有真实根就跳过。
- 不存在的路径证明不了任何归属：除非之前的运行删过它，否则记为 skipped，也不会拿它当删索引的依据。

```mermaid
flowchart TD
  R["pp thread resolve / ticker（PR 合并、空闲 auto_resolve_days）"] --> C["最终拷贝：report 和 library 拷回 threads/、library/<id>/<br/>（声明丢弃且有成品的 library 路径不拷）"]
  C -->|拷贝失败| X["不 resolve，报错"]
  C --> S["记录标为 resolved，归档 agent"]
  D["删检查通过的声明路径（成品已原样归档）"]
  P["先检查所有声明路径；在删任何东西前列出索引并解析根路径"]
  S --> P --> D
  D --> W{"worktree：保留、拷贝不完整，<br/>或检查有原因？"}
  W -->|是| K["保留并写原因"]
  W -->|否| G["git worktree remove（不加 --force）"]
  G --> I["Codebase Memory：删删除前已证明属于本线程的索引，再列一次核实"]
  K --> M["写 threads/<id>.cleanup.json 和 .cleanup.md"]
  I --> M
  M --> B["worktree 没了：归档 workspace，按分支清理规则检查本地分支"]
  RT["pp thread cleanup <slug> <id> [--dry-run]<br/>pp sweep"] --> P
```

## 自动处理的

| 资源 | 什么时候删 | 怎么判断归属 |
|---|---|---|
| 线程的 worktree | 下面所有检查都通过 | 记录里的 `cwd`；`pwd -P` 必须等于 `git rev-parse --show-toplevel`，并且登记在 `t.repo` 的 `git worktree list` 里，不能是主 checkout |
| worktree 里的 `node_modules/` | 跟着 worktree 一起删 | 里面有 `.package-lock.json` 或 `.modules.yaml`，同级或根目录有 git 跟踪的 lockfile，而且它本身不是符号链接 |
| `.paseo-project/<本线程>/` | 跟着 worktree 一起删 | 只有 brief、report、cleanup.json、library（已经拷回家），或者声明丢弃的路径 |
| 声明丢弃的路径 | 检查通过就 `rm -rf` | 见下面的 `cleanup.json` |
| Codebase Memory 索引 | 删除前解析的 `root_path` 在本次删掉的目录里，或者之前的记录登记过它 | 用官方 CLI `codebase-memory-mcp cli --json list_projects / delete_project`，删完再列一次核实。经过符号链接的根按链接实际指向判断；断掉的链接不算 |
| 作者线程的本地分支 | 自有 PR 已合并，worktree 已经没了，分支 tip 等于合并的 head | 和原来一样 |
| 复审线程的本地分支 | 因被审 PR 合并而 resolve，worktree 已经没了，分支 tip 仍等于创建时记录的提交，且另一个本地或远程跟踪分支或标签包含该提交 | 分支名须与创建记录一致。分支有自己的提交、仍被检出、已变动或缺少创建记录时保留 |

worktree 删除前要满足这些条件，任何一条不满足就保留并写原因：

- HEAD 在某个分支或 tag 上能找到；
- 没有 checkout 出来的子模块，git 目录下也没有 `modules/`。空的（未初始化的）子模块可以删；
- 没有未提交改动、untracked 文件，也没有不认识的 ignored 内容；
- 用 `lsof` 确认没有进程打开里面的文件。重试 5 次，每次间隔 1 秒，等刚归档的 agent 退出。没有 `lsof` 就保留。

删除只用 `git worktree remove -- <path>`，不加 `--force`，不跑 `git worktree prune`（它会处理整个仓库），也不跑 `submodule deinit`。worktree 目录已经不在时：如果它还登记在 `t.repo` 里，只移除这一条登记，移除失败记为 failed；如果没登记，就记为 gone，它下面的索引不动。

## 保留的（写明原因）

- `--keep-worktree`，或 `cleanup.json` 里有 `keep`：worktree 保留。sweep 和重试也不会删它（Paseo 的合并自动归档会绕过保留，见下文）。
- 最终拷贝不完整：worktree 保留。`thread resolve --force` 可以删。
- `cleanup.json` 解析不了：不知道哪些要保留，所以全部保留。
- worktree 里有原因的内容：untracked、未提交改动、不认识的 ignored 内容（trace、log、报告、out/ 等）、其他线程的目录。
- 声明的路径是这些情况：符号链接、不在本线程目录或 `/tmp/<id>-…` 下、碰到线程目录（本线程的或别的线程的，或者装着线程目录）、和声明保留的路径重叠、有 git 跟踪的文件；在 library 里但没指明成品，或者成品不存在、不是普通文件、为空、没有原样归档到 home。
- 另一台机器上的线程：不清理声明的路径和索引，worktree 的检查照常通过 ssh 运行。
- 没装 `codebase-memory-mcp`：索引标为 skipped。

默认保留报告、日志、trace、session、脚本、GIF/QA 成品，以及其他没有声明的东西。依赖和原始帧不会搬进 library。

## `cleanup.json`：线程的显式登记

线程把它写在自己的目录里（`.paseo-project/<project>-<id>/cleanup.json`）。相对路径从这个目录算起：

```json
{
  "discard": [
    { "path": "library/rec/frames", "product": "library/rec/demo.gif", "why": "demo.gif 的原始帧" },
    { "path": "/tmp/t-1005-scratch", "why": "测试用的临时目录" }
  ],
  "keep": [{ "path": ".", "why": "用户要看现场" }]
}
```

- `discard` 只能是本线程 worktree（或 tab 目录）里的路径，或者是 `/tmp`、系统临时目录下以 `<线程 id>-` 开头的目录。
- library 里的路径必须带 `product`。成品必须是 library 里非空的普通文件，最终拷贝时不拷原始帧；删除前还要核对 home 里那份成品的 sha256 和 worktree 里的一致。
- 只要有 `keep`，worktree 就整个保留；和 keep 重叠的 discard 也保留，临时目录和 tab 线程也一样。
- 声明会写进清理记录，所以即使 worktree 删掉了，重试时也还能用这份声明。

## 记录与重试

每次运行都会重写这两个文件：

- `threads/<id>.cleanup.json`：`run`、`state`（`complete`，或有 failed 时为 `partial`）、`archive`（这次最终拷贝的结果：`complete`、`partial`、`missing`（附 `archive_missing`）、`unknown`（家里有 library 但没有完整拷贝的记录，附 `archive_unknown`）、重试时可能是 `failed`，用 `--skip-copy` 时为 `skipped`）、`archive_agent`（写这条记录时线程的 agent id）、`removed_kib`，以及每一项的 kind、target、status（removed、gone、kept、failed、skipped）、reason、kib，还有这次用的声明。
- `threads/<id>.cleanup.md`：同样内容的表格。

几个规则：

- 字节数来自删除前的 `du -sk`。共享或克隆的块不算在内，所以它不保证真的释放了这么多空间。
- 之前删掉的项，在之后的运行里显示为 gone 时，保留原来那次删除的记录。
- 失败不会被吞掉，也不会被当成成功：thread 照样 resolve，记录标为 `partial`，inbox 里写明失败的项。`pp thread cleanup <slug> <id>` 重试，重试是幂等的。
- `resolve` 会归档 Paseo agent。工作树已经移除时，也会归档侧边栏里的 workspace。工作树需要保留时，workspace 也保留，因为 Paseo 的 workspace 归档可能删除工作树。`resolve` 和 `thread cleanup` 的输出都会说明 Paseo 归档结果，失败后可以用 `thread cleanup` 重试。
- 再次 `thread resolve` 会报错，并提示改用 `thread cleanup`。
- `--dry-run` 会预览 worktree、声明路径和索引，列出 would-remove，不删东西，也不写记录。它不会重新拷贝，所以 library 里的成品可能还没归档。只有 worktree 已经移除时才检查本地分支并归档 workspace。这两项的结果写在命令输出或 resolve 的 inbox 里。
- `pp sweep` 可重试已登记 Git worktree 的回收和待处理的归档，并清理过期的已处理 inbox 项；不删除 OVNFS checkout，也不会按线程状态、目录名或分支名清扫未接管的历史资源。
- `pp thread discover <slug>` 列出已配置仓库的 Git worktree、历史线程记录及已配置并正在运行的本机 OVNFS 注册表中能与项目关联的条目，不会启动 OVNFS daemon。`pp board resources` 和线程详情显示待确认资源、实际后端、阶段、阻碍和操作。
- 人确认候选项及实际创建基线后，才可运行 `pp thread adopt <slug> <id> --candidate TOKEN --base OID`。已核对的历史 Git worktree 登记到原线程；无归属的 Git worktree 只能登记到同源的托管线程。接管只写 PP 记录，保留原后端、文件、提交和保留约束；身份或起点证据不足时，先独立保存工作，不要将这个 Git 资源交给 PP 托管。未接管的 OVNFS 和远程资源仅报告阻碍。
- 对已核对但未接管的历史 Git worktree，显式清理也会检查该工作树自己的 HEAD reflog。任何无法从保留引用到达的提交都会阻止删除，`--dry-run` 同样显示原因，但不写记录。实际清理会记录 `blocked` 而不是人为保留，资源看板显示阻碍，ticker 留下提醒但不自动重试。`archive_scope` 是 `report-and-library`；即使报告和 library 的拷贝完整，`git_history_archive` 仍可能是 `unknown`。没有已登记分支身份时，PP 保留分支和 reflog；接管后的工作树即使已经回收，资源看板仍会显示保留的分支及原因。
- 接管起点通过工作树 HEAD reflog 和分支 reflog 的创建记录互相核对。这适用于本机单用户模型：reflog 不是认证凭证，同一用户若同时改写两份 reflog 的开头，可能伪造起点。怀疑记录被人为改写时，独立保存工作并保持不托管。

## OVNFS checkout

`--kind ovnfs` 使用本机 OVNFS v0.8.0 管理 checkout。Paseo 将其作为普通目录 workspace 打开，`pp thread restart` 复用原挂载。OVNFS 进程和挂载需要在启动、重启与清理期间可用。PP 启动 OVNFS daemon 时设置 `OVNFS_GIT_REMOTES=0`，已有 daemon 使用自己的配置。

`resolve`、`thread cleanup`、ticker 和 `pp sweep` 可以跟进归档，但不会删除 OVNFS checkout。未接管的历史 OVNFS checkout、工作区及其声明丢弃项也会保留。

接到清理指示的 Agent 可非交互运行 `pp thread delete-checkout <slug> <id> [--resource NAME]`，每次只处理一项。省略 `--resource` 选中主 checkout；实验用其名称。命令要求线程已完成、Agent 已归档、没有有效保留，且本机命名空间、挂载和登记身份一致。它检查 checkout 和私有 Git 目录的占用、依赖、未知内容和可恢复的私有提交，并在副本外验证并保存所需成果。`--keep-worktree` 也阻止这条命令。快照不能删除，依赖关系不明确时也保留。

依赖包括引用该 checkout 的快照，以及 source 位于该 checkout 或其私有 Git 目录内的其他 checkout。命令仅向已运行、并声明支持保留快照和保留提交的非强制删除的后端发出请求；不支持时在记录删除意图前就保留并报错。后端仍可能拒绝仍含未共享提交的 checkout，此时 PP 不改用强制删除。固定版本的按名 `rm` 无法锁住检查后的外部写入或替换。请让目标保持静止。只有注册表、挂载内路径和私有 Git 路径均确认目标已不存在才记为已删除；未挂载或无法查询不是已删除。失败或不确定时查看命令输出和 `pp thread show <slug> <id> --json`，不会后台重试；再次显式运行可核对此前已删除的目标，但不会重发不确定的 `rm`。PP 不删除 base、快照或底层目录；OVNFS 可回收无引用的内部存储。

OVNFS 线程仍支持 `--reviews` 和报告中的 `Reviewed-PR:`。被审 PR 合并可以触发 resolve，但不会触发 checkout 删除；线程有尚未合并的自有 PR 时，也不会因此 resolve。

## 和 Paseo 的合并自动归档冲突

Paseo daemon 的 `daemon.autoArchiveAfterMerge`（默认关闭）打开时，会在 PR 合并后自动归档 workspace。触发条件只有这几条：PR 合并、git 不脏、没有领先 origin、worktree 归 Paseo 所有。满足后它用 `git worktree remove --force`、`rm -rf` 和 `git worktree prune` 删掉 worktree。它不看 pp 的保留决定，不看 ignored 内容（`.paseo-project/` 也在其中），也不看占用的进程。以下冲突涉及以前由 Paseo 创建、未登记工作副本的线程。新线程的 Git worktree 由 pp 登记和创建；身份缺失或不一致时，pp 不会在该目录执行或清理。

- pp 先 resolve、决定保留时：保留守不住。记录里 worktree 的 kept 原因会写明这一点，`pp doctor` 也会提示。
- 读不到这个设置时（daemon 连不上、拒绝读取，或者回了 SDK 不认的格式），按「未知」处理，不当作关闭：kept 原因写「is unknown (原因)」，`pp doctor` 写「could not be read (原因)」。读设置失败不会挡住清理。
- daemon 连不上时，SDK 会一直重连、不会报错，所以 pp 建立连接最多等 15 秒就放弃。这个上限只管建立连接：连上之后的单个请求按 SDK 自己的请求超时，接回已保存会话时（`importSession`，thread 和 coordinator 的重启会用到）用的独立 client 也不受这个上限约束。
- daemon 不答时，ticker 不知道线程的 agent 是否还在工作。未知不算空闲：合并的线程和空闲超过 `auto_resolve_days` 的线程都不自动 resolve，等 daemon 能答再决定。`pp archive` 只在 agent 全部归档成功后才把项目记为 archived，否则项目状态不变。
- Paseo 先删时（合并后 pp 要等报告完成或 10 分钟宽限，所以这是常见顺序）：最终拷贝什么也拿不到。没拷回家的部分会写进说明，比如「the thread folder was already gone: report and library not copied home」。报告平时会随更新拷回，所以家里如果有报告，那是 pp 最后一次拷的；library 只在最终拷贝时拷。清理记录里，`state` 仍然只表示清理本身是否完成，另外记 `archive: "missing"` 和 `archive_missing`。
- 完整拷贝的证明只对写下它的那个 agent 有效（记录里的 `archive_agent` 等于线程当前的 `agent_id`）。`thread resolve --reopen` 之后 `thread restart` 总会换一个新 agent，新一轮写进新 worktree 的 library 不能拿上一轮的 `complete` 来证明；新 worktree 在最终拷贝前没了，就按下一条记为未知。不绑定线程目录，是因为重启后 Paseo 可能把分支检出到同一个路径。
- 家里已经有 `library/<id>/`，但清理记录里没有本 agent 的 `archive: "complete"` 时，不能证明它是完整的。它可能是中途失败的 rsync 留下的（本机和远端一样），也可能来自旧版 pp：旧版的记录没有 `archive` 字段，`resolve --force` 还会在 library 超限没拷时照样删掉 worktree。这种情况记 `archive: "unknown"` 和 `archive_unknown`，说明写「whether the library home is complete is unknown」。
- 之后的 `pp thread cleanup` 重试按磁盘实际状态记录：保留过的 worktree 不在了，就记 gone，不再记 kept。记录里写着 `archive: "complete"`、且 agent 没换过的线程，目录被删掉不算缺失。

要让 pp 成为唯一的删除方，就关掉这个设置：`paseo daemon config set daemon.autoArchiveAfterMerge false`，然后 `paseo daemon reload`。这个设置对整台主机生效，pp 管不到的 workspace 也会一起停止合并后自动归档。Paseo 没有给单个 workspace 豁免的接口。

## 限制

- 只识别 npm/pnpm 的 `node_modules`。其他依赖目录（venv、target/ 等）被当作不认识的 ignored 内容，worktree 会保留。需要删的话由线程在 `cleanup.json` 里声明。
- 删除前列索引失败时，索引会保留：本次删掉的目录下有哪些索引已经无从得知，需要手动删。
- `/tmp/<id>-…` 的前缀只在同一台机器、同一个线程 id 下才唯一。不同项目可能出现相同的 id，所以只有线程自己声明的路径才会被删，不会按名字扫描。
