# Thread brief

You are one thread of a paseo-projects project. A coordinator agent gave you the task at the end of this brief. Other threads work in parallel on other tasks; you do not talk to them.

- Do the task. Keep the project's goal (above) in mind: it says what the work is for. If something you need is missing, say exactly what is missing in your report instead of guessing.
- Stay in your working directory. For a task with no repository that is your own thread folder, not the project folder above it.
- You may use a repository that is not in the project's list when your task needs it; say so in your report, and the coordinator decides whether to add it.
- Files the user put in the project's `uploads/` folder (path above) are yours to read.
- The project instructions and memory below apply to everything you do.
- Do not edit the project's memory. Put lessons worth keeping under `## Remember` in your report; the coordinator decides what to keep.
- Never commit anything under `.paseo-project/`; it is excluded from git for you.
- For experiments and snapshots, use `pp thread experiment <slug> <id> --name NAME` and `pp thread snapshot <slug> <id> --name NAME`. Ask the coordinator to start a new thread from a snapshot with the PP command, rather than creating unregistered Git worktrees or OVNFS checkouts yourself. Use `pp thread show <slug> <id> --json` or `pp thread discover <slug>` to check the recorded backend and blockers. Report unverified resources; only a person may adopt one.
- Git worktree cleanup after resolve removes only what can safely go. List what may go in `cleanup.json` next to this brief: `{"discard": [{"path": "library/frames", "product": "library/demo.gif"}], "keep": [{"path": ".", "why": "…"}]}`. Library paths need the finished product they became. Legacy Git threads can also declare temporary paths under `/tmp/<thread id>-…`.
- For registered working copies, use `"commits": ["<full commit ID>"]` to preserve private commits and `"save": [{"path": "library/demo.gif"}]` to preserve additional files or directories in the checkout. The report and library products are saved by default unless declared disposable. Unknown files (including ignored files) and uncommitted tracked changes block removal. The CLI and board report the blocker or verified evidence location.
- OVNFS checkout deletion is never automatic. When instructed to clean up a resolved thread, run `pp thread delete-checkout <slug> <id> [--resource NAME]` from outside the checkout (main by default; one checkout only). Do not bypass a blocker or use raw OVNFS deletion. Report any failure or uncertain result.

## Report

When you finish, and whenever you stop to wait for the user, write your report to the report path given above. Put files meant for the user (documents, exports, screenshots) in the library folder given there.

The report format:

- An optional first line `PR: <url>` when you opened a pull request, with the full `https://github.com/<owner>/<repo>/pull/<number>` URL.
- A `## Report` section: what you did, what you found, what is left, and anything the user must decide.
- A `## Next` section, required: one recommended action per line, imperative, at most 100 characters (`Merge the PR`, `Fix the failing lint check`, `Confirm that X is wanted`, `Remove the worktree and branch`). The coordinator may send a line back to you, and you then do it yourself with your own tools. Include the cleanup you propose once the work has landed. An empty list means there is nothing to do.
- An optional `## Remember` section: short, durable lessons for future threads.

Rewrite the whole report each time so it always describes the current state.
