# 线程 resolve 后的清理

线程 resolve 时自动清理它留下的东西。只删能确认属于这个线程、并且确实可以丢掉的东西；拿不准就保留，并写下原因。

resolve 自动触发、`pp thread cleanup` 重试、`--dry-run` 预览和 `pp sweep` 用的是同一份实现：`orchestrator/cleanup.mjs` 里的 `run`。

```mermaid
flowchart TD
  R["pp thread resolve / ticker（PR 合并、空闲 auto_resolve_days）"] --> C["最终拷贝：report 和 library 拷回 threads/、library/<id>/<br/>（声明丢弃且有成品的 library 路径不拷）"]
  C -->|拷贝失败| X["不 resolve，报错"]
  C --> S["记录标为 resolved，归档 agent"]
  S --> D["声明丢弃的路径：检查归属，成品已原样归档后 rm"]
  D --> W{"worktree：保留、拷贝不完整，<br/>或检查有原因？"}
  W -->|是| K["保留并写原因"]
  W -->|否| G["git worktree remove（不加 --force）"]
  G --> I["Codebase Memory：删根目录在已删目录里的索引，再列一次核实"]
  K --> M["写 threads/<id>.cleanup.json 和 .cleanup.md"]
  I --> M
  M --> B["worktree 没了：归档 workspace；PR 已合并且分支 tip 等于合并 head 时删本地分支"]
  RT["pp thread cleanup <slug> <id> [--dry-run]<br/>pp sweep"] --> D
```

## 自动处理的

| 资源 | 什么时候删 | 怎么判断归属 |
|---|---|---|
| 线程的 worktree | 下面所有检查都通过 | 记录里的 `cwd`；`pwd -P` 必须等于 `git rev-parse --show-toplevel`，并且登记在 `t.repo` 的 `git worktree list` 里，不能是主 checkout |
| worktree 里的 `node_modules/` | 跟着 worktree 一起删 | 里面有 `.package-lock.json` 或 `.modules.yaml`，同级或根目录有 git 跟踪的 lockfile，而且它本身不是符号链接 |
| `.paseo-project/<本线程>/` | 跟着 worktree 一起删 | 只有 brief、report、cleanup.json、library（已经拷回家），或者声明丢弃的路径 |
| 声明丢弃的路径 | 检查通过就 `rm -rf` | 见下面的 `cleanup.json` |
| Codebase Memory 索引 | 它的 `root_path` 在本次删掉（或之前已经删掉）的目录里 | 用官方 CLI `codebase-memory-mcp cli --json list_projects / delete_project`，删完再列一次核实 |
| 已合并的本地分支 | worktree 已经没了，分支 tip 等于合并的 head | 和原来一样 |

worktree 删除前要满足这些条件，任何一条不满足就保留并写原因：

- HEAD 在某个分支或 tag 上能找到；
- 没有 checkout 出来的子模块，git 目录下也没有 `modules/`。空的（未初始化的）子模块可以删；
- 没有未提交改动、untracked 文件，也没有不认识的 ignored 内容；
- 用 `lsof` 确认没有进程打开里面的文件。重试 5 次，每次间隔 1 秒，等刚归档的 agent 退出。没有 `lsof` 就保留。

删除只用 `git worktree remove -- <path>`，不加 `--force`，不跑 `git worktree prune`（它会处理整个仓库），也不跑 `submodule deinit`。worktree 目录已经不在时，只移除这一条登记。

## 保留的（写明原因）

- `--keep-worktree`，或 `cleanup.json` 里有 `keep`：worktree 保留。sweep 和重试也不会删它。
- 最终拷贝不完整：worktree 保留。`thread resolve --force` 可以删。
- `cleanup.json` 解析不了：不知道哪些要保留，所以全部保留。
- worktree 里有原因的内容：untracked、未提交改动、不认识的 ignored 内容（trace、log、报告、out/ 等）、其他线程的目录。
- 声明的路径是这些情况：符号链接、不在本线程目录或 `/tmp/<id>-…` 下、包含线程目录、有 git 跟踪的文件；在 library 里但没指明成品，或者成品不存在、不是普通文件、为空、没有原样归档到 home。
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
- 只要有 `keep`，worktree 就整个保留。
- 声明会写进清理记录，所以即使 worktree 删掉了，重试时也还能用这份声明。

## 记录与重试

每次运行都会重写这两个文件：

- `threads/<id>.cleanup.json`：`run`、`state`（`complete`，或有 failed 时为 `partial`）、`removed_kib`，以及每一项的 kind、target、status（removed、gone、kept、failed、skipped）、reason、kib，还有这次用的声明。
- `threads/<id>.cleanup.md`：同样内容的表格。

几个规则：

- 字节数来自删除前的 `du -sk`。共享或克隆的块不算在内，所以它不保证真的释放了这么多空间。
- 之前删掉的项，在之后的运行里显示为 gone 时，保留原来那次删除的记录。
- 失败不会被吞掉，也不会被当成成功：thread 照样 resolve，记录标为 `partial`，inbox 里写明失败的项。`pp thread cleanup <slug> <id>` 重试，重试是幂等的。
- 再次 `thread resolve` 会报错，并提示改用 `thread cleanup`。
- `--dry-run` 走同样的检查，会列出 would-remove，不删东西，也不写记录。它不会重新拷贝，所以 library 里的成品可能还没归档。
- `pp sweep` 会对 resolved 线程残留的 worktree 再跑一次 `thread cleanup`，跳过保留的。不属于任何线程的 `pp-<slug>-t-NNNN` worktree 也走同样的 worktree 检查。

## 限制

- 只识别 npm/pnpm 的 `node_modules`。其他依赖目录（venv、target/ 等）被当作不认识的 ignored 内容，worktree 会保留。需要删的话由线程在 `cleanup.json` 里声明。
- `/tmp/<id>-…` 的前缀只在同一台机器、同一个线程 id 下才唯一。不同项目可能出现相同的 id，所以只有线程自己声明的路径才会被删，不会按名字扫描。
