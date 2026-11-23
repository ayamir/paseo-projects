# Issue tracker: GitHub

本仓库的 issue 和规格保存在 ayamir/paseo-projects 的 GitHub Issues。
使用 gh CLI，并显式指定 --repo ayamir/paseo-projects。

## Conventions

- 发布规格：创建 GitHub issue，标签遵循 triage-labels.md。
- 创建 issue：gh issue create --repo ayamir/paseo-projects --title "..." --body-file <file>。
- 读取 issue：gh issue view <number> --repo ayamir/paseo-projects --json number,title,body,labels,comments。
- 列出 issue：gh issue list --repo ayamir/paseo-projects --state open --json number,title,labels；
  按需要增加 --label、--state 和分页。
- 多行正文和评论使用实际换行的 UTF-8 文件及 --body-file，
  不通过字符串插值拼接 shell 命令。
- 评论：gh issue comment <number> --repo ayamir/paseo-projects --body-file <file>。
- 标签：gh issue edit <number> --repo ayamir/paseo-projects --add-label "..." 或 --remove-label "..."。
- 关闭：先发布原因，再使用 gh issue close；不要依赖已关闭 issue 的 close 命令发布解释。
- 子任务优先使用 GitHub 原生 sub-issue；不可用时，在子 issue 顶部注明 Part of #<parent>。
- 阻塞优先使用 GitHub 原生 issue dependencies；
  不可用时注明 Blocked by: #<number>，所有阻塞项关闭后才可开始。
- 调用原生关系 API 时使用 API 返回的 issue 数据库 id，不将 issue 编号或 node_id 当作数据库 id。
- 创建前核对目标仓库；不得向 skills 上游仓库或其他无关仓库发布本项目内容。

## Pull requests as a triage surface

PRs as a request surface: no.

## When a skill says "publish to the issue tracker"

创建 GitHub issue。

## When a skill says "fetch the relevant ticket"

读取对应 GitHub issue 的正文、标签和评论。
