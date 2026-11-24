# #14：OVNFS 真后端验收与默认切换门槛

## 复跑与门槛

在可普通挂载、卸载本机 NFS 的 macOS 上，从干净、已提交的仓库根目录运行，将证据输出到工作树外。需要已安装的项目依赖、Node v26.13.1，以及与本机架构匹配的 OVNFS v0.8.0。无需真实 Paseo、Agent、GitHub、凭据或网络服务。

```sh
node scripts/check-ovnfs.mjs /absolute/path/to/ovnfs /absolute/path/to/git > /absolute/scratch/evidence.json
node bin/pp.mjs working-copy promotion --evidence /absolute/scratch/evidence.json
```

验收命令在任何用例未通过时返回非零，仍输出 JSON。它使用全新的合成仓库、PP 根与 HOME，每次试验独立的 OVNFS state 和 mount，以及仅监听回环的假 Paseo。只有核对自有 daemon 的进程和端点、并用 `nfsstat` 核对 NFS 挂载后才对其派工。即使假 Paseo 未能停止，也独立尝试对已确认归属的 daemon 普通停机。daemon 提前退出、子进程状态不明或无法确认普通卸载时，保留 fixture，释放运行器的子进程句柄，并在 stderr 提示本地路径。不强制卸载，不重复请求不确定的停机。验收未使用或修改用户的运行配置。

`pp working-copy promotion` 独立报告 `reliability`、`measured_benefit` 和 `thresholds`。`measured` 表示数据完整且输出匹配，但还没通过阈值；没有阈值、配对不完整、输出不匹配或任一可靠性用例失败都会阻止切换。只有全部通过时才报告 `eligible` 并返回 0；该命令始终只读，**不会**修改 Git worktree 默认值。

可选 `--thresholds FILE` 读取事先审批的 JSON，不调用 PP 配置。文件使用 `schema: 2`、非空审批引用 `approval`、`metric: "useful-build-v2"`、与证据相同的 `provenance`（`revision`、含版本及二进制 SHA-256 的 `candidate`、合成 Git `baseline`、`workload` 摘要），以及 `limits` 下的 `cold`、`hot`、`dirty-derive`。每个场景至少要有一项经审批的上限：`first_use_ms`、`total_ms` 或 `retained_allocated_bytes`，用 OVNFS / Git worktree 的正数比值表示。至少一项须要求严格改善（比值低于 1）；每组配对都须符合适用的上限。这是审批记录的本地一致性检查，不是签名认证。仓库不提供假定的阈值或默认审批。

Schema 2 的验收、匹配测量和全量回归引用同一组 `provenance`。回归逐文件运行无过滤的 `test/*.test.mjs`；门槛要求同一 Git `HEAD` 的已审文件哈希、逐文件预期通过数及完整汇总，不接受名称过滤结果，即使它显示零跳过。测试文件改动后，须用无过滤回归重新核对并更新 `promotion.mjs` 中的清单。每次配对试验须有对应场景完整的 v2 阶段和可核对的计时，不能混用旧试验。主机 OS、架构、Node、Git、文件系统及 OVNFS 版本和架构也必须有记录，且 OVNFS 版本须与候选二进制身份一致。

## 测量口径

- 两个后端串行运行。每个场景各两组，顺序为 Git → OVNFS、OVNFS → Git；每项使用新 fixture，同一基线、合成数据和离线构建（读取 96 个跟踪文件、锁定文件、主输入及合成依赖并计算摘要）。冷指无声明缓存，不清 OS cache。热场景计入同一份声明种子的准备成本，重复派工两次，再破坏种子以验证冷重建。脏派生对两边施加同一处跟踪修改：OVNFS 快照，Git 提交；再各尝试派生两个子副本。成功构建须匹配预期摘要。
- `useful-build-v2` 从 fixture 准备后开始。`first_use_ms` 到首个构建完成，`total_ms` 到最后一个构建完成；计入 daemon 启动、场景缓存或脏输入准备、实际 PP 派工和构建，排除额外挂载预检及构建后摘要、缓存状态验证。`inclusive_total_ms` 保留这些预检和验证时间。结案与 teardown 单列。`to_capture_ready_ms` 是派工期间以 10 ms 周期观察到的 capture 路径，不是独立相加的计时，也不等同于后端分配耗时。失败样本不用于收益比较。
- 结案后的 `retained` 统计源仓、PP、后端 backing state、未回收 Git worktree 的不重叠根路径，不累加 NFS 视图。逻辑字节为常规文件长度；分配字节按 `du -sk`，包含文件系统记账且共享 APFS extent 可重复计费；**唯一物理字节和可回收物理空间未知**。结案保留与最终 fixture 清除分开，不把 teardown 算作 PP 回收成功。合成负载、共享机器与只有两组配对意味着结果不能外推。

## 历史实测（旧口径）：未放行

这次工具修订没有重新启动真 OVNFS：以下是旧口径数据，**没有 `useful-build-v2` 真后端数据**。旧版派工含重复预检，构建含摘要校验，场景总时长还含缓存状态验证。历史数据不用于新门槛。

实测基线 `fa3a57c01547b5977cee08c99225e5db8f09c2f5`；macOS 27.2.1 arm64 / APFS，Git 2.56.1，Node v26.13.1，OVNFS v0.8.0 darwin arm64（go1.27.3）。[原始测量与验收结果](working-copy-acceptance.json)含二进制 SHA-256、两组试验顺序、各阶段时间、构建摘要与保留空间。回归、可靠性诊断复跑和性能试验相互独立，不把调试复跑计作第三组性能样本。

- **AC27，未通过。** 真 NFSv3 Unix socket 挂载、受控 capture、私有 Git、声明缓存隔离、实验与快照、ticker 结案后保留、快照依赖保护均通过。跨线程派生注册了子副本，但其私有 Git 中的 generation marker 仍属于父实验，PP 在启动 Agent 前拒绝。普通停机、重挂后 checkout 注册表未增删，NFS inode 未变但设备号变了，PP 拒绝重启同一 checkout，没有重复创建 checkout 或 Agent。
- **AC29，未通过。** 未结案、占用和 daemon 离线均拒绝删除，自动结案、cleanup、ticker、sweep 均保留 checkout。在健康挂载上，PP 已独立归档文件与 Git bundle，但真实 OVNFS v0.8.0 的非强制 `rm` 拒绝删除仍保有一项独有提交的 checkout：受控 capture 没有分支可达该提交。文件与提交均从归档独立恢复；注册表与路径仍在，PP 状态为 `unknown`，没有记成回收成功。没有强制或重复删除。
- **AC28，已取得冷和声明热场景的匹配样本，未达到切换门槛。** 冷、热的构建结果均匹配；脏派生的第一份 OVNFS 子副本在两组均遇到同一 generation 错误。下表范围是两次样本的取值区间，不是置信区间。

| 场景 | Git 首次 / 总时长，ms | OVNFS 首次 / 总时长，ms | 结案后记录的分配字节，Git / OVNFS |
| --- | ---: | ---: | ---: |
| 冷 | 562–592 / 562–592 | 982–1043 / 982–1043 | 1,794,048 / 3,104,768 |
| 声明热复用＋失效 | 597–637 / 2238–2298 | 1094–1142 / 3761–3805 | 4,546,560 / 6,086,656 |
| 脏现场派生两份 | 1108–1174 / 1653–1710 | 无成功构建；1887–1985 时首份报错 | 3,117,056 / 3,190,784（失败后） |

冷场景 OVNFS daemon 就绪用时 128–129 ms，派工内首次观察到 capture 路径用时 348–368 ms。真实普通 teardown 在各 OVNFS 试验用时 106–131 ms；清除了全部本次独立实测 fixture。这不是 PP checkout 回收成功。历史 Node v26.13.1 定向回归 15/15，全量串行回归 120/120。新门槛拒绝 schema 1 历史数据并返回 1（`reliability: invalid`、`measured_benefit: invalid`、`thresholds: missing`）。三个真实后端阻塞未修复，默认仍为 Git worktree。
