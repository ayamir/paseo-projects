<p align="center"><img src="https://img.shields.io/badge/Paseo%20Projects-Projects%20for%20Paseo-2ea44f?style=flat-square&labelColor=24292f" alt="Paseo Projects | Projects for Paseo" /></p>

<h3 align="center">Run a whole project across your coding agents without handing each one its task or keeping track of who is doing what</h3>

<p align="center">Paseo Projects lets you run a larger piece of work on the Paseo daemon when one agent isn't enough and managing five by hand is a job in itself. You talk to one coordinator agent. It starts a separate agent for each task on its own branch, gives every one of them the same goal, instructions and memory, and a board in the Paseo app shows you which threads need you, which are ready for review and which are still working.</p>

<p align="center"><sub>✓&nbsp;Free,&nbsp;MIT&nbsp;licensed &nbsp; ✓&nbsp;Runs&nbsp;on&nbsp;your&nbsp;machines,&nbsp;no&nbsp;hosted&nbsp;service &nbsp; ✓&nbsp;Node.js,Node&nbsp;22+,&nbsp;Paseonbsp;Paseo&nbsp;0.13.2+</sub></p>

<p align="center"><sub>A port of <a href="https://github.com/eliasstravik/herdr-projects">herdr-projects</a> from Herdr to Paseo. Same project folders, same coordinator and thread model, so a herdr-projects root can be taken over in place.</sub></p>

<br />

## Keep one conversation going while the work happens in parallel

The coordinator never does the work itself, so it's always free to answer you. Each task runs in its own thread: a separate Paseo agent in its own git worktree and branch, in the repository's main checkout, or in its own folder when there's no repository. You read reports and answer the threads that need you instead of briefing every agent yourself.

## What Paseo gives it

| herdr-projects | paseo-projects |
|---|---|
| coordinator pane | a Paseo agent in the project folder, labelled `project=<slug>, role=coordinator` |
| thread pane and worktree | a Paseo agent with a `branch-off` worktree, branch `pp-<slug>-t-NNNN-<title>` |
| reading the pane, sending keys | Paseo's structured permission requests: `thread permissions`, `allow`, `deny` |
| typing a prompt | `send` with `steer`, so a busy agent gets it inside its current turn |
| SSH machines | remote Paseo daemons (`machines.<name>.url`), plus `ssh` to copy reports home |
| the `prefix+a` popup | a board in the Paseo app sidebar with the same six tabs |

## Tell the coordinator what you want. See which thread needs you on the board.

### 📈 See every thread at a glance

The board (the Tasks icon at the top of the Paseo sidebar) has six tabs: threads, tasks, inbox, routines, settings and memory. Threads are grouped by what needs you first: waiting for you, ready for review, ready to merge, working, idle, resolved. Each shows its own progress line and its list of next steps. Every button on the board runs one `pp` command, so the board can do nothing the CLI can't. Settings are edited in place: tap a row, change it, save.

### ⚡ Stop briefing every agent yourself

Say what you want once. The coordinator proposes threads and waits for your go-ahead, then each thread starts from a brief with the project's goal, your standing instructions, the project's memory and its task, on the profile you pick (Claude Code, Codex, OpenCode or any provider Paseo runs). Lessons a thread reports under `## Remember` flow back into memory for the next one.

### 💬 Know when a thread needs an answer

Agents report their own progress, so a thread that asked you something shows `needs you` even when it looks idle. A background ticker copies reports home, writes inbox items when a thread changes state, follows pull requests (failing checks and review comments go back to the thread), resolves a thread when its pull request is merged, runs routines, and nudges the coordinator when its inbox has something new.

### 🔁 Pick up where an agent left off

Every agent's provider session is recorded. `pp open` brings back a coordinator on its last session, and `pp thread restart` brings back a thread on its own, so closing the app or the daemon doesn't lose a conversation.

## Open your first project in three steps

<table>
<tr>
<td align="center" valign="top" width="33%"><h3>1️⃣</h3><b>Install</b><br /><sub>Clone this repository, run <code>npm install</code>, start the daemon with <code>paseo start</code>, and add the board with <code>paseo plugin install ./plugin</code>. Optionally link <code>pp</code> onto your path with <code>npm link</code>.</sub></td>
<td align="center" valign="top" width="33%"><h3>2️⃣</h3><b>Create and open a project</b><br /><sub>Run <code>pp new billing --name "Billing" --repo ~/dev/app</code>, then <code>pp open billing</code>. A coordinator agent starts in the project's folder and the ticker starts with it.</sub></td>
<td align="center" valign="top" width="33%"><h3>3️⃣</h3><b>Tell it what you want</b><br /><sub>Talk to the coordinator in the Paseo app. It suggests threads, you say go ahead, and the board shows each thread's state as it works.</sub></td>
</tr>
</table>

```sh
git clone https://github.com/ayamir/paseo-projects && cd paseo-projects
npm install
paseo start                                   # local daemon at ws://127.0.0.1:6767/ws
paseo plugin install ./plugin                 # the board
node bin/pp.mjs new billing --name "Billing" --goal "Ship invoices" --repo ~/dev/app
node bin/pp.mjs open billing                  # coordinator + ticker
```

`pp help` lists every command.

## Commands you'll use

```sh
pp list                                       # every project and what needs you
pp context <slug>                             # the coordinator's digest
pp thread start <slug> --title T --task-file brief.md [--repo PATH] [--kind worktree|tab|checkout] [--profile P]
pp thread list <slug>                         # grouped by what needs you
pp thread prompt <slug> <id> --text "…"       # steer a thread
pp thread permissions|allow|deny <slug> <id>  # answer its permission requests
pp thread restart <slug> <id> [--fresh]       # bring it back on its old session
pp thread resolve <slug> <id>                 # report copied home, worktree removed
pp ticker start|stop|status
pp doctor [--fix]
```

Thread kinds:

- `worktree` (the default with `--repo`): its own worktree and branch.
- `checkout`: the repository's main checkout, shared with you.
- `tab` (the default without `--repo`): its own folder, `threads/<id>/`. With `--repo` it still shows under that repository's project in the Paseo sidebar. Good for research that reads the code and writes nothing.

## Get your questions answered

### Where does my project live?

In the root set by `root` in `config.json` (default `projects/` in this repository; `--root` or `PP_ROOT` override it). Each project is a folder: `PROJECT.md` for your settings and standing instructions, `AGENTS.md` and `CLAUDE.md` for priming the coordinator, `MEMORY.md` and `memory/` for what it remembers, `TASKS.md` for the task list it keeps for you, `routines/`, `inbox/`, `uploads/` for files you give the threads, `threads/` for thread records and reports, and `library/` for files threads produced. `config.json` holds profiles, defaults, safety settings and machines; no agent edits it.

### What does only a person do?

Commands that widen what agents may do refuse unless they run at a terminal: `pp safety set|yolo`, `pp routine approve`, and `pp profile add|edit|remove|allow|default`. The board can change these too: on macOS it opens a system dialog naming the exact command, and the change happens only when you click Allow. An agent calling the board's RPC itself only raises that dialog. Project settings (`pp set`) change straight from the board.

### What are profiles?

A named launch config in `config.json`: a provider and model (`claude/claude-opus-5-5`), a mode, a thinking level and the mode that skips permission prompts. Every Paseo provider is also a built-in profile of the same name. The coordinator picks a profile for each thread; you choose which ones it may pick with `pp profile allow`.

```sh
pp profile add reviewer --provider claude/claude-opus-5-5 --thinking high --description "Hard reviews"
pp profile default thread reviewer
pp profile allow billing thread reviewer sonnet
```

### What if the safety settings aren't enough?

They are soft. By default the coordinator proposes threads and waits (until you turn on yolo), thread agents keep their normal permission prompts, and routines may not run shell commands until you enable them and approve each command at a terminal. But agents have a shell: one that runs with permission prompts skipped can edit those files, and whatever reaches memory is repeated in every later brief.

### I use herdr-projects. Can I switch?

Yes. `node bin/cutover-herdr.mjs [HERDR_ROOT] --dry-run` shows what it would do; without `--dry-run` it stops both tickers (`--wait` waits until no pane is mid-turn), makes the herdr root this tool's root and converts its projects in place (herdr's own state files move to `.state/herdr/`), closes the herdr panes, then opens each coordinator and restarts each open thread on its old Claude session. `pp migrate-herdr` copies projects instead. Remove the herdr-projects hooks from `~/.claude/settings.json` yourself afterwards.

### Does it send my project to a hosted service?

No. A project is a folder on your machine, `pp` talks to your own Paseo daemons, and reports come home over your own SSH. Your agent CLI still uses its own service as usual.

### Will it touch my branches or worktrees on its own?

Only to clean up after a thread is resolved: by you, when its pull request is merged, or after `auto_resolve_days` idle. It removes the worktree (never forced, so uncommitted changes keep it) and, only if the pull request is merged, the local branch. The report and the thread's files are copied home first.

### What is known not to work yet?

- Restoring and importing agents uses Paseo's internal daemon client; recheck it after an SDK upgrade.
- A root reached through a symbolic link (`/tmp` on macOS) does not find the last Claude session on restart.

## More

- [docs/README.zh-CN.md](docs/README.zh-CN.md): the full notes in Chinese (ticker, sessions, cutover, thread groups, board).
- `skill/COORDINATOR.md` and `skill/THREAD.md`: what the coordinator and each thread are told.
- `skill/autoproject/`: a reviewed improvement loop the coordinator can run.
- `npm test` runs the logic tests; no daemon needed.

Paseo Projects is free and [MIT licensed](LICENSE). It is a port of [herdr-projects](https://github.com/eliasstravik/herdr-projects) by Elias Stravik.
