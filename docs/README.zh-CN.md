# paseo-projects

herdr-projects 的项目模型（coordinator + threads + inbox + ticker），跑在 Paseo 上：每个 coordinator 和 thread 都是一个 Paseo agent，worktree、权限请求、模型和远程机器都由 Paseo daemon 提供。

## 快速开始

```sh
npm install                       # @getpaseo/client
paseo start                       # 本地 daemon（ws://127.0.0.1:6767/ws）
node bin/pp.mjs new myproj --name "My Project" --goal "…" --repo /abs/path/to/repo
node bin/pp.mjs open myproj       # 启动 coordinator 和常驻 ticker
```

之后在 Paseo app 里和 coordinator 对话（或用 `paseo send <id> "…"`）。由 coordinator 开线程、转发跟进、回答线程的权限请求，并维护 `TASKS.md` 和记忆。`pp help` 列出全部命令。

## 模型

| herdr-projects | paseo-projects |
|---|---|
| coordinator pane | Paseo agent，cwd 为项目目录，labels `project=<slug>, role=coordinator` |
| thread pane + worktree | Paseo agent，`worktree: branch-off`，labels `role=thread, thread=t-NNNN`，分支 `pp-<slug>-t-NNNN-<title>` |
| `thread read` / `thread keys` | `thread permissions` / `thread allow` / `thread deny`（Paseo 的结构化权限请求） |
| 粘贴 brief | brief 写入 `<worktree>/.paseo-project/<slug>-<id>/brief.md`，并发送一行启动提示 |
| `prompt` 打字回车 | `send`，使用 `activeTurnBehavior: "steer"`（忙时插入当前回合） |
| herdr session / SSH machine | 本地 daemon / `config.json` 的 `machines.<name>.url`（Paseo daemon）+ `ssh`（拷贝报告用） |
| profiles (config.toml) | `config.json` 的 `profiles`：`provider`、`mode`、`thinking`、`yolo_mode` |

项目目录与 herdr 相同：`PROJECT.md`（`+++` 设置 + 指令）、`AGENTS.md`/`CLAUDE.md`、`MEMORY.md`、`memory/`、`TASKS.md`、`routines/`、`threads/`、`inbox/`、`library/`、`uploads/`、`scratch/`、`.state/`。

## Ticker

`pp ticker start|stop|status|run`。每个 root 一个常驻进程，`pp open` 会自动启动它，日志写在 `<root>/.ticker.log`。它每 15 秒执行一遍，做这些事：

- 把线程报告拷回 `threads/<id>.md`；
- 根据状态变化写 inbox 条目：等你处理、新报告、待合并、空闲；
- 每 120 秒跟进 PR，并触发 `on = "pr"` routine；
- 合并后和空闲超过 `auto_resolve_days` 的线程自动 resolve；
- 运行定时 routine。命令型 routine 需要用户在终端执行 `pp routine approve`；
- coordinator 空闲 60 秒后，用 `[pp inbox] …` nudge 它。

## 接续会话

ticker 会把每个 agent 的 provider session id 记进线程记录（`session`）和 `.state/coordinator.json`。agent 被归档或关掉之后：

- `pp thread restart <slug> <id>`：用 Paseo 的 `importAgent` 接回原 session，再设上 profile 的 model 和 mode。`--fresh` 新开会话。worktree 已经没了时只能新开。
- `pp open <slug>`：coordinator 不在时接回它上次的 session。`--fresh` 或 `--profile` 新开会话。
- 从 herdr 迁来的项目：`migrate-herdr` 把 herdr coordinator 的 session（`.state/coordinator.json` 的 `agent_session`）和每个线程 pane 的 Claude session（线程 cwd 对应的 Claude 目录里最新的那个，checkout 线程除外）记下来，所以 `pp open` 和 `thread restart` 直接接回，不用再给 `--session`。Claude 只在 cwd 对应的目录里找 session，所以接回前会把 session 文件**复制**到新 cwd 的目录，原文件保持不变。从 herdr 接回的 coordinator 会先收到一条提示：herdr 命令不能再用，请先执行 `pp skill`。一定要先在 herdr 里关掉对应的 pane，否则两边会同时写同一个 session。
- `pp thread restart <slug> <id> --session latest|<id>`：手动指定 session。`latest` 取 `~/.claude/projects/<cwd>/` 里最新的 Claude session。

`importAgent` 是 Paseo 的内部 API（`@getpaseo/client/internal/daemon-client`），升级 SDK 后要复查。

## 从 herdr 切换

切换后，PP 的 root 就是 `~/.herdr-projects`，直接用 HP 原来的项目目录，不再拷贝。`node bin/cutover-herdr.mjs [HERDR_ROOT] [--dry-run] [--yes] [--wait]` 按下面的顺序做：

1. 停掉 herdr-projects 和 pp 两边的 ticker。加了 `--wait` 时，等到没有 pane 在工作再往下做，每 15 秒重新扫一次，期间新开的线程也算在内。如果 herdr 的 ticker 被重新拉起，脚本就中止。
2. 把 `config.json` 的 `root` 设成 HP 的 root，然后执行 `migrate-herdr`。root 和 HP 的 root 相同时，`migrate-herdr` 就地转换：
   - 两边同名、内容不同的 HP 文件移到 `<项目>/.state/herdr/`：`AGENTS.md`、`CLAUDE.md`、`.state/coordinator.json`、`ticker.json` 等。
   - 每个 `threads/t-NNNN.toml` 旁边写一个 `.json`，`.toml` 保留。
   - session 优先从还开着的 pane 读取（`herdr pane get` 的 `agent_session`），读不到再取 Claude 目录里最新的。所以这一步要在关 pane 之前做。
   - `TASKS.md`、`MEMORY.md`、`memory/`、`inbox/`、报告等原样使用。
3. 关闭 herdr 里各项目的 coordinator pane 和未完成线程的 pane。只关 cwd 和记录一致的 pane，不关运行脚本的那个 pane。
4. 对每个项目执行 `pp open`，对每个未完成的线程执行 `thread restart`。cwd 没有变，所以直接接回原来的 Claude session。线程的报告目录从 `.herdr-project/` 换到 `.paseo-project/`，restart 时会把旧报告复制过去。

先用 `--dry-run` 看看会关哪些 pane。不加 `--wait` 时，正在工作的 pane 会丢掉当前这一轮。不加 `--yes` 时，要在终端里确认一次。`~/.claude/settings.json` 里 herdr-projects 的 hook 要你自己删掉。

想退回 HP：把 `.state/herdr/` 里的文件移回原处，删掉 `threads/*.json`，再去掉 `config.json` 的 `root`。

## Profile

profile 存在 `config.json`。下面这些命令只能由人在终端执行，coordinator 只能用 `pp context` 列出的名字：

- `pp profile add reviewer --provider claude/claude-opus-5-5 --thinking high --description "难的评审"`：新建。`edit` 只改给出的字段，空值（`--mode ""`）清掉该字段。
- `pp profile remove <name>`：如果 defaults、allow-list 或某个项目的 `thread_profile`/`coordinator_profile` 还在用它，就拒绝。
- `pp profile allow <slug>|--global thread|coordinator <名字...>`：限定可用的 profile。不给名字表示都可以，`default` 表示继承上一级。
- `pp profile default thread|coordinator <name>`：新项目的默认值。已有项目用 `pp set <slug> thread_profile <name>` 改。
- `pp profile list [--project <slug>]`、`pp profile resolve [name] [--project <slug>]`：查看 profile，以及它启动时用的 agent 配置（JSON）。

## 线程分组

优先级从高到低：

1. 等你处理：启动失败或超时、agent 不在且没有报告、agent 出错、权限请求挂起超过 30 秒、线程自报 `Waiting for you`。
2. 待评审：有未 ack 的新报告，或者 PR 已开。
3. 待合并：PR 已批准。
4. 进行中。
5. 空闲。
6. 已解决。

线程用 `pp report --percent N --activity '…'` 自报进度（brief 里给出了带 `--thread` 的完整命令）。

## 看板

在 Paseo 侧栏顶部点 Tasks 图标打开。看板有 6 个 tab，和 HP 的 popup 一一对应：线程、任务、Inbox、Routines、设置、记忆。每个按钮都执行一条 `pp` 命令：

- 任务：派工、完成、放弃。三个按钮都是把请求发给 coordinator，由它来改 TASKS.md。
- Routines：开启或关闭。
- 设置：点一行就能改。项目设置（`pp set`）直接生效。安全设置、profile 和新项目的默认 profile 只能由人改：保存后弹出 macOS 对话框，上面写着完整命令，点 Allow 才执行，取消或 100 秒没点就拒绝。
- 记忆：只读，要改跟 coordinator 说。

`pp board tasks|routines|settings|memory` 输出看板读取的 JSON。

## 仅限用户

以下命令要求在终端里由人执行，agent 调用会被拒绝：

- `pp safety set|yolo`、`pp profile add|edit|remove|allow|default`；
- `pp routine approve`；
- 编辑 `config.json` 和 `approved-routines.json`。

这些命令设了 `PP_ASK=dialog`（看板就是这样调用的）时，在 macOS 上会弹对话框问你，而不是直接拒绝。agent 自己设这个变量，也只是弹出一个要你确认的对话框。

## 测试

```sh
npm test      # 纯逻辑：TOML、TASKS.md、分组、brief、inbox、PR、routine
```

旧原型（`step0/`、`.trash/`）没有放进仓库。
