# #14：OVNFS 真后端验收与默认切换门槛

## 复跑与门槛

在可普通挂载、卸载本机 NFS 的 macOS 上，从仓库根目录运行。需要已安装的项目依赖、Node v26.13.1，以及与本机架构匹配的 OVNFS v0.8.0。无需真实 Paseo、Agent、GitHub、凭据或网络服务。

```sh
node scripts/check-ovnfs.mjs /absolute/path/to/ovnfs /absolute/path/to/git > evidence.json
node bin/pp.mjs working-copy promotion --evidence evidence.json
```

验收命令在任何用例未通过时返回非零，仍输出 JSON。它使用全新的合成仓库、PP 根与 HOME，每次试验独立的 OVNFS state 和 mount，以及仅监听回环的假 Paseo。只有核对自有 daemon 的进程和端点、并用 `nfsstat` 核对 NFS 挂载后才对其派工。停机只针对该 daemon，普通卸载无法确认时保留 fixture 并在 stderr 提示本地路径，不重复发出可能强制卸载的请求。验收未使用或修改用户的运行配置。

`pp working-copy promotion` 独立报告 `reliability`、`measured_benefit` 和 `thresholds`。`measured` 表示数据完整且输出匹配，但还没通过阈值；没有阈值、配对不完整、输出不匹配或任一可靠性用例失败都会阻止切换。只有全部通过时才报告 `eligible` 并返回 0；该命令始终只读，**不会**修改 Git worktree 默认值。

可选 `--thresholds FILE` 读取事先审批的 JSON，不调用 PP 配置。文件使用 `schema: 1`、非空审批引用 `approval`、与证据相同的 `candidate`（含二进制 SHA-256）和 `workload`，以及 `limits` 下的 `cold`、`hot`、`dirty-derive`。每个场景至少要有一项经审批的上限：`first_use_ms`、`total_ms` 或 `retained_allocated_bytes`，用 OVNFS / Git worktree 的正数比值表示。至少一项须要求严格改善（比值低于 1）；每组配对都须符合适用的上限。这是审批记录的本地一致性检查，不是签名认证。仓库不提供假定的阈值或默认审批。

## 测量口径

- 两个后端串行运行。每个场景各两组，顺序为 Git → OVNFS、OVNFS → Git；每项使用新 fixture，同一基线、合成数据和离线构建（读取 96 个跟踪文件、锁定文件、主输入及合成依赖并计算摘要）。冷指无声明缓存，不清 OS cache。热场景计入同一份声明种子的准备成本，重复派工两次，再破坏种子以验证冷重建。脏派生对两边施加同一处跟踪修改：OVNFS 快照，Git 提交；再各尝试派生两个子副本。成功构建须匹配预期摘要。
- 首次可用从 fixture 准备后开始，计入 OVNFS daemon 启动、派工和首个成功构建；总时长至最后一个成功构建，均不含结案与 teardown。原始数据分列 fixture/daemon、派工、构建、结案与 teardown；`to_capture_ready_ms` 是派工期间以 10 ms 周期观察到的 capture 路径，不是独立相加的计时，也不等同于后端分配耗时。试验页上的失败时间不能当作成功首次可用。
- 结案后的 `retained` 统计源仓、PP、后端 backing state、未回收 Git worktree 的不重叠根路径，不累加 NFS 视图。逻辑字节为常规文件长度；分配字节按 `du -sk`，包含文件系统记账且共享 APFS extent 可重复计费；**唯一物理字节和可回收物理空间未知**。结案保留与最终 fixture 清除分开，不把 teardown 算作 PP 回收成功。合成负载、共享机器与只有两组配对意味着结果不能外推。

## 实测：未放行

实测基线 `fa3a57c01547b5977cee08c99225e5db8f09c2f5`；macOS 27.2.1 arm64 / APFS，Git 2.56.1，Node v26.13.1，OVNFS v0.8.0 darwin arm64（go1.27.3）。[原始测量与验收结果](working-copy-acceptance.json)含二进制 SHA-256、两组试验顺序、各阶段时间、构建摘要与保留空间。回归、可靠性诊断复跑和性能试验相互独立，不把调试复跑计作第三组性能样本。

- **AC27，未通过。** 真 NFSv3 Unix socket 挂载、受控 capture、私有 Git、声明缓存隔离、实验与快照、ticker 结案后保留、快照依赖保护均通过。跨线程派生注册了子副本，但其私有 Git 中的 generation marker 仍属于父实验，PP 在启动 Agent 前拒绝。普通停机、重挂后 checkout 注册表未增删，NFS inode 未变但设备号变了，PP 拒绝重启同一 checkout，没有重复创建 checkout 或 Agent。
- **AC29，未通过。** 未结案、占用和 daemon 离线均拒绝删除，自动结案、cleanup、ticker、sweep 均保留 checkout。在健康挂载上，PP 已独立归档文件与 Git bundle，但真实 OVNFS v0.8.0 的非强制 `rm` 拒绝删除仍保有一项独有提交的 checkout：受控 capture 没有分支可达该提交。文件与提交均从归档独立恢复；注册表与路径仍在，PP 状态为 `unknown`，没有记成回收成功。没有强制或重复删除。
- **AC28，已取得冷和声明热场景的匹配样本，未达到切换门槛。** 冷、热的构建结果均匹配；脏派生的第一份 OVNFS 子副本在两组均遇到同一 generation 错误。下表范围是两次样本的取值区间，不是置信区间。

| 场景 | Git 首次 / 总时长，ms | OVNFS 首次 / 总时长，ms | 结案后记录的分配字节，Git / OVNFS |
| --- | ---: | ---: | ---: |
| 冷 | 562–592 / 562–592 | 982–1043 / 982–1043 | 1,794,048 / 3,104,768 |
| 声明热复用＋失效 | 597–637 / 2238–2298 | 1094–1142 / 3761–3805 | 4,546,560 / 6,086,656 |
| 脏现场派生两份 | 1108–1174 / 1653–1710 | 无成功构建；1887–1985 时首份报错 | 3,117,056 / 3,190,784（失败后） |

冷场景 OVNFS daemon 就绪用时 128–129 ms，派工内首次观察到 capture 路径用时 348–368 ms。真实普通 teardown 在各 OVNFS 试验用时 106–131 ms；清除了全部本次独立实测 fixture。这不是 PP checkout 回收成功。Node v26.13.1 定向回归 15/15，全量串行回归 120/120。按仓库内证据运行门槛返回 1：`reliability: failed`、`measured_benefit: failed`、`thresholds: missing`。默认仍为 Git worktree。
