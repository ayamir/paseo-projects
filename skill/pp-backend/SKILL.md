---
name: pp-backend
description: Choose a paseo-projects working-copy backend before starting a repository thread. Use when dispatching local or SSH work, deciding whether to reuse large build caches, or deriving from an OVNFS snapshot.
---

# Choose a PP backend for the task

Run `pp context <slug>` and confirm the repo and machine. Use the exact PP command prefix from context. Choose based on what the task needs before it can produce useful work, not repo size alone. An explicit user choice takes precedence if PP supports it.

| Task | Choice |
| --- | --- |
| Ordinary code change, review that needs a checkout, extension-only build, small or cold cache, or uncertain benefit | `--kind worktree`. Use this for SSH repos too. |
| Local task that needs a substantial, already-warm set of ignored build/dependency directories | `--kind ovnfs` only for a repo the user has approved for OVNFS and where those specific caches are known to be usable. A repo's `ovnfs-preferred` opt-in is not a reason to use it for lightweight tasks. |
| Start from a specific managed OVNFS snapshot | `--from-snapshot THREAD/RESOURCE`; it selects OVNFS. Do not combine it with `--base` or `--inherit-dirty`. |
| Carry the local source's dirty tracked changes into an isolated thread | `--kind worktree --inherit-dirty` at HEAD, without `--base`. It does not import untracked or ignored files. |
| No repository, or research without a checkout | Omit `--repo` for a repo-less task, or use `--kind tab` when the task has a repo but needs no checkout of its own. Use `--kind checkout` on the main checkout only when the user specifically asks. |

For a fresh OVNFS checkout, `pp working-copy ovnfs` verifies the existing local namespace and daemon. It does not tell you whether the dependencies the task needs are present. OVNFS opens a committed base and can reuse ignored files from the source under its native rules. Do not assume a cold cache, dirty edits, initialized submodule Git metadata, or a submodule's ignored dependencies will carry over. If those are required and not verified, use Git worktree with an explicit setup step, or ask if Git will not meet the task's requirements.

Name the backend and one reason in the dispatch proposal or confirmation. Pass the corresponding flag to `pp thread start`; omit `--kind` only when intentionally relying on the configured policy or when another flag selects the backend. A preferred policy may fall back to Git at preflight; an explicit OVNFS request does not. Verify the actual backend with `pp thread show <slug> <id>` and report any fallback. If a start fails after a copy was registered, inspect that thread before retrying; do not launch a duplicate or substitute raw Git/OVNFS commands.

This skill does not change project or repository defaults, start or reconfigure a daemon, give approval to start a thread, or authorize deletion. Existing PP start gates and cleanup rules still apply.

## Evidence

[Real-repository comparison](../../docs/working-copy-acceptance.md#真实仓库对照) found that Git was faster for dispatch and the first small extension build, while OVNFS was faster to reach parity on a broad set of already-warm main-repository caches. That is not a claim about full builds or a reason to change the global default. Reuse the decision rule, not the timing ratio, on another workload.
