# Domain Docs

本仓库采用 single-context。

## Before exploring, read these

- 根级 GLOSSARY.md。
- docs/adr/ 中与当前工作有关的 ADR。
- 涉及工作副本生命周期或 OVNFS 时，读取 docs/ovnfs-design.md；
  对应规格位于 docs/specs/working-copy-lifecycle.md。

缺少可选领域文档时继续工作，不因缺失而阻塞或预先创建空文档。
未来若出现 GLOSSARY-MAP.md，按其索引读取相关上下文。

## Use the glossary's vocabulary

issue、规格、实现、假设和测试使用词汇表定义的领域术语，
避免使用词汇表明确排除的同义表达。

缺少所需概念时先判断是否引入了不必要的新术语；
确有领域空缺时记录给后续 domain-modeling。

## Flag ADR conflicts

若方案与已有 ADR 冲突，明确指出冲突和理由，不静默覆盖。
区分已确认设计、待确认规格和实际已部署能力。
