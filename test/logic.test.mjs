// Pure logic: parsers, grouping, PR reduction, schedules. No daemon, no gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml, splitFront, slugify } from "../orchestrator/lib.mjs";
import * as tasks from "../orchestrator/tasks.mjs";
import * as threads from "../orchestrator/threads.mjs";
import * as inbox from "../orchestrator/inbox.mjs";
import * as pr from "../orchestrator/pr.mjs";
import * as routines from "../orchestrator/routines.mjs";
import { create, applySetting } from "../orchestrator/project.mjs";
import { convertThread, convertProfile } from "../orchestrator/migrate.mjs";

test("parseToml: values, multi-line arrays, inline tables, [[tables]]", () => {
  const v = parseToml('a = "x # y" # c\nb = 3\nc = true\nd = [\n  "p",\n  "q",\n]\ne = { k = 1 }\n\n[[repos]]\npath = "/r"\n[[repos]]\npath = "/s"\nmachine = "m"');
  assert.deepEqual(v, { a: "x # y", b: 3, c: true, d: ["p", "q"], e: { k: 1 }, repos: [{ path: "/r" }, { path: "/s", machine: "m" }] });
  assert.equal(splitFront("+++\na = 1\n+++\nbody").body, "body");
  assert.equal(splitFront("no front"), null);
  assert.equal(slugify("Fix the Login bug!"), "fix-the-login-bug");
});

test("tasks: owners, parse, compact, launchFor", () => {
  assert.deepEqual(tasks.parseOwner("sonnet@m1"), { type: "agent", profile: "sonnet", machine: "m1" });
  assert.deepEqual(tasks.parseOwner("@m1"), { type: "agent", profile: null, machine: "m1" });
  assert.equal(tasks.parseOwner("Priya Rao").type, "person");
  const md = "# Tasks\n\n## Backlog\n- [ ] Fix login (sonnet) · t-0007\n  line one\n  line two\n- [ ] Mine (me)\n";
  const list = tasks.parse(md);
  assert.equal(list.length, 2);
  assert.equal(list[0].thread, "t-0007");
  assert.equal(list[0].description, "line one\nline two");
  assert.match(tasks.compact(md), /notes: line one \(\+1 more lines in TASKS.md\)/);
  assert.deepEqual(tasks.launchFor(list[0], undefined, undefined), { profile: "sonnet", machine: null });
  assert.throws(() => tasks.launchFor(list[1]), /user's own task/);
  assert.throws(() => tasks.launchFor(list[0], "opus"), /assigned to profile/);
});

test("nextLines strips markers and stops at the next heading", () => {
  assert.deepEqual(threads.nextLines("## Report\nx\n## Next\n- Merge the PR\n* Fix CI\n2. Clean up\n\n## Remember\n- no"), ["Merge the PR", "Fix CI", "Clean up"]);
  assert.equal(threads.branchName("p", "t-0001", "Fix it!"), "pp-p-t-0001-fix-it");
  assert.ok(threads.isOwnBranch("p", "pp-p-t-0001-fix-it"));
  assert.ok(!threads.isOwnBranch("p", "pp-p-x-t-0001"));
});

const T = (o = {}) => ({ status: "open", created: new Date(0).toISOString(), report_hash: "", acked_report_hash: "", pr_state: "", pr_review: "", last_state: "", last_state_change: "", ...o });
const agent = (o = {}) => ({ status: "idle", pendingPermissions: [], archivedAt: null, ...o });

test("group precedence", () => {
  const at = Date.now();
  const g = (t, a, p) => threads.group(t, threads.liveOf(t, a, p ?? null, at), at).group;
  assert.equal(g(T({ status: "resolved" }), null), "resolved");
  assert.equal(g(T({ status: "starting", created: new Date(at - 10_000).toISOString() }), null), "working");
  assert.equal(g(T({ status: "starting" }), null), "waiting-on-you");
  assert.equal(g(T(), null), "waiting-on-you"); // no agent, no report
  // blocked only counts after the debounce
  const blockedNow = T({ last_state: "blocked", last_state_change: new Date(at - 5000).toISOString() });
  assert.equal(g(blockedNow, agent({ pendingPermissions: [{}] })), "working");
  assert.equal(g({ ...blockedNow, last_state_change: new Date(at - 60_000).toISOString() }, agent({ pendingPermissions: [{}] })), "waiting-on-you");
  assert.equal(g(T(), agent(), { activity: threads.WAITING, percent: 50, reported_at: at / 1000 }), "waiting-on-you");
  assert.equal(g(T({ report_hash: "h", pr_state: "OPEN", pr_review: "APPROVED" }), agent()), "landing");
  assert.equal(g(T({ report_hash: "h" }), agent()), "ready-for-review");
  assert.equal(g(T({ report_hash: "h" }), agent({ status: "running" })), "working");
  assert.equal(g(T({ report_hash: "h", acked_report_hash: "h" }), agent()), "idle");
  assert.equal(g(T({ report_hash: "h", acked_report_hash: "h" }), null), "idle"); // agent gone after a report
});

test("composeBrief inlines memory under the cap and lists the rest", () => {
  const b = threads.composeBrief({
    projectName: "P", slug: "p", goal: "", repos: [{ path: "/r", machine: null }], uploads: "/u", remote: false,
    instructions: "be nice", memoryIndex: "# Memory", memoryFiles: [["a.md", "small"], ["b.md", "x".repeat(threads.MEMORY_CAP_CHARS)]],
    task: "do it", restart: true, threadMd: "# Thread brief", report: "/w/report.md", library: "/w/library", reportCommand: "pp report --thread p/t-0001",
  });
  assert.match(b, /## memory\/a\.md\n\nsmall/);
  assert.match(b, /Not inlined .*memory\/b\.md/);
  assert.match(b, /previous attempt/);
  assert.match(b, /# Task\n\ndo it/);
});

test("inbox: write, nudge text, done", () => {
  const root = mkdtempSync(join(tmpdir(), "pp-"));
  const p = create(root, "demo", { name: "Demo" });
  inbox.write(p, "thread-state", "t-0001", "new report", "x");
  inbox.write(p, "pr", "t-0001", "PR merged", "y");
  inbox.write(p, "routine", "daily", "due", "z", "body");
  const items = inbox.unhandled(p);
  assert.equal(items.length, 3);
  assert.equal(inbox.nudgeText(items), "[pp inbox] routine daily due; t-0001 PR merged, new report");
  assert.equal(inbox.done(p, [items[0].id]), 1);
  assert.equal(inbox.unhandled(p).length, 2);
  assert.equal(applySetting(p.settings(), "repos.add", "/x@m1").repos[0].machine, "m1");
});

test("pr: remotes, reduce, events, report refs", () => {
  assert.deepEqual(pr.parseRemote("git@github.com:Org/Repo.git"), { host: "github.com", repo: "org/repo" });
  assert.equal(pr.parseRemote("https://gitlab.com/a/b"), null);
  assert.equal(pr.prLine("PR: https://github.com/a/b/pull/12\n").url, "https://github.com/a/b/pull/12");
  assert.ok(pr.prLine("PR: nope").note);
  const json = JSON.stringify({ state: "OPEN", reviewDecision: "", headRefName: "pp/x/t-0001", headRefOid: "abc", headRepository: { name: "b" }, headRepositoryOwner: { login: "a" },
    statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }], comments: [{ author: { login: "rev" } }], reviews: [] });
  const s = pr.reduce(json, "pp/x/t-0001", "git@github.com:a/b.git").summary;
  assert.deepEqual(s.failing_checks, ["lint"]);
  assert.ok(pr.reduce(json, "other", "git@github.com:a/b.git").ignored);
  assert.deepEqual(pr.prEvents(null, s, "me"), ["opened", "checks-failed", "review"]);
  assert.deepEqual(pr.prEvents(s, { ...s, state: "MERGED" }, "me"), ["merged"]);
  const refs = pr.reportRefs("see #5 and https://github.com/c/d/pull/9. also a#7", "git@github.com:a/b.git", "https://github.com/c/d/pull/9");
  assert.deepEqual([...refs.entries()].map(([k, v]) => [k, [...v]]), [["a/b", [5]]]);
});

test("routines: schedules and parse", () => {
  assert.deepEqual(routines.parseSchedule("every 2h"), { every: 7200 });
  assert.deepEqual(routines.parseSchedule("daily 09:30"), { daily: [9, 30] });
  assert.throws(() => routines.parseSchedule("hourly"));
  const at = new Date(2026, 9, 27, 10, 0);
  assert.equal(routines.isDue({ daily: [9, 30] }, new Date(2026, 9, 27, 9, 0), at), true);
  assert.equal(routines.isDue({ daily: [9, 30] }, new Date(2026, 9, 27, 9, 45), at), false);
  assert.equal(routines.isDue({ every: 3600 }, new Date(at - 3_600_000), at), true);
  const r = routines.parse("pf", '+++\non = "pr"\nevents = ["review"]\n+++\nfix it');
  assert.deepEqual(r.trigger, { pr: ["review"] });
  assert.throws(() => routines.parse("x", '+++\non = "pr"\ncommand = "ls"\n+++\n'), /no `command`/);
});

test("migrate: herdr tables, thread records, profiles", () => {
  const c = parseToml('[safety."/h/p"]\nyolo = true\n\n[profiles.worker]\nagent = "claude"\nmodel = "group/group[1m]"');
  assert.deepEqual(c, { safety: { "/h/p": { yolo: true } }, profiles: { worker: { agent: "claude", model: "group/group[1m]" } } });
  assert.deepEqual(convertProfile(c.profiles.worker), { provider: "claude/group/group[1m]" });
  const t = convertThread({ id: "t-0007", kind: "tab", cwd: "/h/p/threads/t-0007", thread_dir: "/h/p/threads/t-0007/.herdr-project/p-t-0007", pane_id: "w:p1", status: "open" }, "/h/p", "/n/p");
  assert.equal(t.cwd, "/n/p/threads/t-0007");
  assert.equal(t.thread_dir, "/n/p/threads/t-0007/.herdr-project/p-t-0007");
  assert.equal(t.agent_id, "");
  assert.equal(convertThread({ id: "t-0001", cwd: "/h/px/w" }, "/h/p", "/n/p").cwd, "/h/px/w"); // a sibling prefix is not the folder
});

test("resume: latest Claude session, which session a restart picks up", () => {
  const base = mkdtempSync(join(tmpdir(), "pp-sessions-"));
  const dir = join(base, "-Users-a--herdr-w-x-y");
  mkdirSync(dir);
  writeFileSync(join(dir, "old.jsonl"), "");
  writeFileSync(join(dir, "new.jsonl"), "");
  writeFileSync(join(dir, "notes.txt"), "");
  utimesSync(join(dir, "old.jsonl"), 1, 1);
  assert.equal(threads.latestSession("/Users/a/.herdr/w/x_y", base), "new");
  assert.equal(threads.latestSession("/nowhere", base), null);

  const t = { cwd: "/w", session: { provider: "claude", id: "rec" } };
  const agent = { persistence: { provider: "claude", sessionId: "live" } };
  assert.deepEqual(threads.sessionFor(t, agent, "claude"), { provider: "claude", id: "live" });
  assert.deepEqual(threads.sessionFor(t, undefined, "claude"), { provider: "claude", id: "rec" });
  assert.equal(threads.sessionFor(t, agent, "claude", { fresh: true }), null);
  assert.equal(threads.sessionFor(t, agent, "codex"), null); // another provider cannot pick it up
  assert.equal(threads.sessionFor({ cwd: "/w", session: null }, undefined, "claude"), null);
  assert.deepEqual(threads.sessionFor(t, agent, "claude", { session: "abc" }), { provider: "claude", id: "abc" });
  assert.throws(() => threads.sessionFor(t, agent, "codex", { session: "latest" }), /Claude sessions only/);
});

test("profiles: add, edit clears empty fields, remove refuses while named", async () => {
  const { changeProfile, profileUses } = await import("../orchestrator/config.mjs");
  const raw = { defaults: { thread_profile: "w" }, safety: { "/p": { coordinator_profiles: ["r"] } } };
  changeProfile(raw, "add", "r", { provider: "claude/claude-opus-5-5", mode: "auto" });
  assert.throws(() => changeProfile(raw, "add", "r", { provider: "claude" }), /exists/);
  assert.throws(() => changeProfile(raw, "add", "x", {}), /--provider/);
  changeProfile(raw, "edit", "r", { mode: "", thinking: "high" });
  assert.deepEqual(raw.profiles.r, { provider: "claude/claude-opus-5-5", thinking: "high" });
  assert.deepEqual(profileUses(raw, "r"), ["safety /p coordinator_profiles"]);
  assert.throws(() => changeProfile(raw, "remove", "r"), /still named/);
  raw.safety["/p"].coordinator_profiles = [];
  changeProfile(raw, "remove", "r");
  assert.deepEqual(raw.profiles, {});
  assert.throws(() => changeProfile(raw, "edit", "claude", {}), /built-ins/);
});

test("placeClaudeSession: copies a session from another folder into the cwd's, once", async () => {
  const { placeClaudeSession, claudeDir } = await import("../orchestrator/lib.mjs");
  const base = mkdtempSync(join(tmpdir(), "pp-claude-"));
  mkdirSync(join(base, "-old", "s1", "subagents"), { recursive: true });
  writeFileSync(join(base, "-old", "s1.jsonl"), "{}\n");
  writeFileSync(join(base, "-old", "s1", "subagents", "a.jsonl"), "x");
  placeClaudeSession("s1", "/new/cwd", base);
  assert.equal(claudeDir("/new/cwd", base), join(base, "-new-cwd"));
  assert.equal(readFileSync(join(base, "-new-cwd", "s1.jsonl"), "utf8"), "{}\n");
  assert.equal(readFileSync(join(base, "-new-cwd", "s1", "subagents", "a.jsonl"), "utf8"), "x");
  assert.equal(readFileSync(join(base, "-old", "s1.jsonl"), "utf8"), "{}\n");
  placeClaudeSession("missing", "/other", base); // nothing to copy: no folder made
  assert.ok(!existsSync(join(base, "-other")));
});

test("migrate-herdr in place: herdr's colliding files set aside, records converted, run twice is a no-op", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readdirSync, readlinkSync } = await import("node:fs");
  const h = mkdtempSync(join(tmpdir(), "pp-hp-"));
  const d = join(h, "p");
  mkdirSync(join(d, "threads"), { recursive: true });
  mkdirSync(join(d, ".state"), { recursive: true });
  writeFileSync(join(d, "PROJECT.md"), '+++\nname = "P"\n+++\n');
  writeFileSync(join(d, "AGENTS.md"), "herdr agents\n");
  writeFileSync(join(d, ".state", "coordinator.json"), JSON.stringify({ pane_id: "w:p1", agent: "claude", agent_session: "s-1" }));
  writeFileSync(join(d, ".state", "ticker.json"), "{}");
  writeFileSync(join(d, "threads", "t-0001.toml"), 'id = "t-0001"\ntitle = "x"\nstatus = "open"\nkind = "tab"\ncwd = "/nowhere"\nagent = "codex"\n');
  writeFileSync(join(h, "hp.toml"), '[defaults]\nthread_profile = "omp"\n\n[profiles.opus]\nagent = "claude"\nmodel = "claude-opus-5-5"\ndescription = "big"\n');
  const run = () => execFileSync(process.execPath, ["bin/pp.mjs", "--root", h, "migrate-herdr", h], { encoding: "utf8", env: { ...process.env, PP_CONFIG: join(h, "c.json"), HP_CONFIG: join(h, "hp.toml") } });
  assert.match(run(), /convert .* in place, 1 thread record/);
  assert.deepEqual(readdirSync(join(d, ".state", "herdr")).sort(), ["AGENTS.md", "coordinator.json", "ticker.json"]);
  assert.equal(readFileSync(join(d, ".state", "herdr", "AGENTS.md"), "utf8"), "herdr agents\n");
  assert.match(readFileSync(join(d, "AGENTS.md"), "utf8"), new RegExp(`--root ${h}`));
  assert.equal(readlinkSync(join(d, "CLAUDE.md")), "AGENTS.md");
  assert.deepEqual(JSON.parse(readFileSync(join(d, ".state", "coordinator.json"), "utf8")).session, { provider: "claude", id: "s-1", from: "herdr" });
  assert.equal(JSON.parse(readFileSync(join(d, "threads", "t-0001.json"), "utf8")).cwd, "/nowhere");
  assert.ok(existsSync(join(d, "threads", "t-0001.toml")));
  // herdr's profiles and defaults come over as they are.
  const c = JSON.parse(readFileSync(join(h, "c.json"), "utf8"));
  assert.deepEqual([c.profiles, c.defaults], [{ opus: { provider: "claude/claude-opus-5-5", description: "big" } }, { thread_profile: "omp" }]);
  assert.match(run(), /skipped, already converted/);
});

test("sessionOfPane: only a Claude pane still in the record's folder", async () => {
  const { sessionOfPane } = await import("../orchestrator/migrate.mjs");
  const pane = { agent: "claude", cwd: "/w", foreground_cwd: "/w/sub", agent_session: { kind: "id", value: "s-9" } };
  assert.equal(sessionOfPane(pane, "/w"), "s-9");
  assert.equal(sessionOfPane(pane, "/w/sub"), "s-9");
  assert.equal(sessionOfPane(pane, "/other"), null); // a reused pane id
  assert.equal(sessionOfPane({ ...pane, agent: "codex" }, "/w"), null);
  assert.equal(sessionOfPane(null, "/w"), null);
});

test("carryReport: a moved thread keeps its last report, never over a new one", () => {
  const files = { "/old/report.md": "old" };
  const h = { read: (p) => files[p] ?? null, write: (p, t) => { files[p] = t; } };
  threads.carryReport(h, "/old", "/new", "home");
  assert.equal(files["/new/report.md"], "old");
  files["/new/report.md"] = "fresh";
  threads.carryReport(h, "/old", "/new", "home");
  assert.equal(files["/new/report.md"], "fresh");
  threads.carryReport(h, "/gone", "/n2", "home"); // old folder gone: the home copy
  assert.equal(files["/n2/report.md"], "home");
  threads.carryReport(h, "/n3", "/n3", "home"); // same folder: nothing to do
  assert.equal(files["/n3/report.md"], undefined);
});

test("boardData: tasks, routines (broken ones too), settings and memory of a project", async () => {
  const { boardData } = await import("../orchestrator/board.mjs");
  const root = mkdtempSync(join(tmpdir(), "pp-board-"));
  const p = create(root, "demo", { name: "Demo" });
  writeFileSync(p.path("TASKS.md"), "# Tasks\n\n## Backlog\n- [ ] Fix login (sonnet) · t-0007\n  why\n");
  writeFileSync(p.path("routines", "bad.md"), "no front matter");
  writeFileSync(p.path("memory", "a.md"), "rule a");
  assert.deepEqual(boardData(root, "tasks"), [{ project: "demo", list: "Backlog", title: "Fix login", owner: "sonnet", thread: "t-0007", notes: "why" }]);
  const r = boardData(root, "routines");
  assert.ok(r.some((x) => x.name === "pr-followup" && !x.error));
  assert.ok(r.some((x) => x.name === "routines/bad.md" && x.error));
  assert.equal(boardData(root, "settings").projects[0].settings.name, "Demo");
  assert.deepEqual(boardData(root, "memory").map((m) => m.file), ["MEMORY.md", "memory/a.md"]);
  assert.throws(() => boardData(root, "nope"), /usage/);
});

test("tabWorkspace: in the repo's Paseo project, reused on restart, none without a repo or project", async () => {
  const made = [];
  const c = {
    projects: { list: async () => ({ projects: [{ projectId: "prj_r", projectRootPath: "/r" }] }) },
    workspaces: {
      list: async () => ({ entries: [{ id: "wks_old", projectId: "prj_r", workspaceDirectory: "/p/threads/t-0001" }] }),
      ref: (id) => ({ id }),
      create: async (o) => { made.push(o); return { id: "wks_new" }; },
    },
  };
  assert.equal((await threads.tabWorkspace(c, "/p/threads/t-0001", "/r", "x")).id, "wks_old");
  assert.equal((await threads.tabWorkspace(c, "/p/threads/t-0002", "/r", "y")).id, "wks_new");
  assert.deepEqual(made, [{ source: { kind: "directory", path: "/p/threads/t-0002", projectId: "prj_r" }, title: "y" }]);
  assert.equal(await threads.tabWorkspace(c, "/p/threads/t-0003", "", "z"), null);
  assert.equal(await threads.tabWorkspace(c, "/p/threads/t-0003", "/other", "z"), null);
});

test("board editArgs: each scope maps to its pp command; nothing reads as a flag", async () => {
  const { editArgs } = await import("../orchestrator/board.mjs");
  assert.deepEqual(editArgs({ scope: "project", target: "demo", key: "max_parallel_threads", value: "3" }), ["set", "demo", "max_parallel_threads", "3"]);
  assert.deepEqual(editArgs({ scope: "safety", target: "demo", key: "thread_profiles", value: "a, b" }), ["safety", "set", "demo", "thread_profiles", "a", "b"]);
  assert.deepEqual(editArgs({ scope: "profile", target: "rev", key: "yolo_mode", value: "--x" }), ["profile", "edit", "rev", "--yolo-mode=--x"]);
  assert.deepEqual(editArgs({ scope: "profile", target: "rev", key: "add", value: "claude/m" }), ["profile", "add", "rev", "--provider=claude/m"]);
  assert.deepEqual(editArgs({ scope: "default", target: "thread", key: "profile", value: "rev" }), ["profile", "default", "thread", "rev"]);
  assert.throws(() => editArgs({ scope: "project", target: "demo", key: "goal", value: "--root /x" }), /cannot start/);
  assert.throws(() => editArgs({ scope: "safety", target: "demo", key: "yolo", value: "on --global" }), /cannot start/);
  assert.throws(() => editArgs({ scope: "project", target: "../x", key: "name", value: "n" }), /not a project/);
  assert.throws(() => editArgs({ scope: "profile", target: "rev", key: "arg", value: "" }), /not a profile field/);
});

test("pr_checks off: a check-only change is no change, so no inbox item, event or routine", () => {
  const old = { state: "OPEN", review_decision: "", failing_checks: [], comment_count: 0, commenters: [], activity: {} };
  const now = { ...old, failing_checks: ["ci"] };
  assert.deepEqual(pr.prEvents(old, pr.withChecks(now, true), "me"), ["checks-failed"]);
  assert.deepEqual(pr.withChecks(now, false), old);
  assert.deepEqual(pr.prEvents(old, pr.withChecks(now, false), "me"), []);
  assert.equal(applySetting({ repos: [] }, "pr_checks", "false").pr_checks, false);
});
