// Resolve-time cleanup, end to end through the CLI: an isolated pp root, a throwaway repo and worktree
// per case, and a fake codebase-memory-mcp. No real Paseo daemon (a fake one for records with a workspace), no real index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const TMP = realpathSync(tmpdir());
const BASE = mkdtempSync(join(TMP, "pp-cleanup-"));
process.env.PP_CONFIG = join(BASE, "config.json");
const { create, writeSettings } = await import("../orchestrator/project.mjs");
const PP = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pp.mjs");

const FAKE_CBM = join(BASE, "fake-cbm.mjs");
writeFileSync(FAKE_CBM, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const [, , cli, json, tool, raw] = process.argv;
const file = process.env.FAKE_CBM_STATE, s = JSON.parse(readFileSync(file, "utf8")), args = JSON.parse(raw || "{}");
appendFileSync(file + ".log", tool + " " + raw + "\\n");
const out = (v, isError) => { console.log(JSON.stringify({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }], ...(isError ? { isError } : {}) })); process.exit(isError ? 1 : 0); };
if (cli !== "cli" || json !== "--json") out("bad call", true);
if (tool === "list_projects") { const o = args.offset ?? 0, l = args.limit ?? 50; out({ projects: s.projects.slice(o, o + l), total: s.projects.length, has_more: o + l < s.projects.length }); }
if (tool === "delete_project") {
  if (s.failDelete) out("database is locked", true);
  s.projects = s.projects.filter((p) => p.name !== args.project); writeFileSync(file, JSON.stringify(s)); out({ project: args.project, status: "deleted" });
}
out("unknown tool", true);
`);
chmodSync(FAKE_CBM, 0o755);

// A fake Paseo daemon on the SDK's wire protocol: it reads daemon.autoArchiveAfterMerge as `on`/`off`, refuses the
// read (`reject`), answers it in a shape the SDK rejects (`malformed`), and archives workspaces. Port 1 is no daemon.
const NO_DAEMON = "ws://127.0.0.1:1/ws";
const WS = createRequire(fileURLToPath(import.meta.resolve("@getpaseo/client"))).resolve("ws");
const FAKE_DAEMON = join(BASE, "fake-daemon.mjs");
writeFileSync(FAKE_DAEMON, `import ws from ${JSON.stringify(pathToFileURL(WS).href)};
const mode = process.env.FAKE_DAEMON_MODE, wss = new ws.WebSocketServer({ port: 0, host: "127.0.0.1" });
wss.on("listening", () => console.log(wss.address().port));
wss.on("connection", (s) => s.on("message", (raw) => {
  const m = JSON.parse(String(raw)), send = (message) => s.send(JSON.stringify({ type: "session", message }));
  if (m.type === "ping") return s.send(JSON.stringify({ type: "pong" }));
  if (m.type === "hello") return send({ type: "status", payload: { status: "server_info", serverId: "fake" } });
  const r = m.message ?? {}, requestId = r.requestId;
  if (r.type === "get_daemon_config_request" && mode === "reject") return send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "permission denied" } });
  if (r.type === "get_daemon_config_request") return send({ type: "get_daemon_config_response", payload: { requestId, config: mode === "malformed" ? "nope" : { mcp: { injectIntoAgents: false }, autoArchiveAfterMerge: mode === "on" } } });
  if (r.type === "archive_workspace_request") return send({ type: "archive_workspace_response", payload: { requestId, workspaceId: r.workspaceId, archivedAt: new Date().toISOString(), error: null } });
  if (requestId) send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "not faked" } });
}));
`);
async function fakeDaemon(mode) {
  if (mode === "down") return { url: NO_DAEMON, stop: () => {} };
  const child = spawn(process.execPath, [FAKE_DAEMON], { env: { ...process.env, FAKE_DAEMON_MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((ok, no) => { child.stdout.once("data", (d) => ok(String(d).trim())); child.once("exit", () => no(new Error("the fake daemon exited"))); });
  return { url: `ws://127.0.0.1:${port}/ws`, stop: () => child.kill() };
}

const G = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"];
const git = (cwd, ...a) => execFileSync("git", [...G, "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
let n = 9100;

/** A project with one open worktree thread on a fresh repo, its brief folder and report in place. */
function fixture({ inRepo = false, daemon = "" } = {}) {
  const id = `t-${++n}`;
  const root = mkdtempSync(join(BASE, "root-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(join(repo, "package.json"), "{}\n");
  write(join(repo, "package-lock.json"), "{}\n");
  write(join(repo, ".gitignore"), "node_modules/\nout/\n.wt/\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
  const p = create(root, "demo", { repos: [{ path: repo }] });
  const wt = inRepo ? join(repo, ".wt", "x") : join(root, "wt");
  const branch = `pp-demo-${id}`;
  git(repo, "worktree", "add", "-q", "-b", branch, wt);
  const td = join(wt, ".paseo-project", `demo-${id}`);
  write(join(td, "brief.md"), "brief\n");
  write(join(td, "report.md"), "## Report\nfinal\n\n## Next\n");
  mkdirSync(join(td, "library"));
  write(join(repo, ".git", "info", "exclude"), ".paseo-project/\n");
  const record = { id, title: "x", status: "open", error: "", kind: "worktree", repo, origin: "", branch, base: "", machine: "", cwd: wt, thread_dir: td, agent_id: "", workspace_id: daemon ? `wks_${id}` : "", profile: "", provider: "", created: new Date().toISOString(), updated: "", last_state: "", last_state_change: "", last_group: "", report_hash: "", last_report_change: "", last_review_item_hash: "", acked_report_hash: "", pr: "", pr_state: "", pr_review: "", resolved_reason: "", kept_worktree: false, session: null };
  writeFileSync(p.path("threads", `${id}.json`), JSON.stringify(record));
  const cbm = join(root, "cbm.json");
  writeFileSync(cbm, JSON.stringify({ projects: [] }));
  // A record with a workspace talks to `daemon` (a fake); any other never reaches the real one.
  const env = { ...process.env, PP_CODEBASE_MEMORY_BIN: FAKE_CBM, FAKE_CBM_STATE: cbm, PASEO_URL: daemon || NO_DAEMON };
  const pp = (...args) => {
    const r = spawnSync(process.execPath, [PP, "--root", root, ...args], { encoding: "utf8", env, timeout: 45_000 });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}${r.error ? `\n${r.error.message}` : ""}` };
  };
  const cleanup = () => JSON.parse(readFileSync(p.path("threads", `${id}.cleanup.json`), "utf8"));
  const item = (kind, target) => cleanup().items.find((i) => i.kind === kind && (!target || i.target === target));
  const indexes = (v) => { const s = JSON.parse(readFileSync(cbm, "utf8")); if (v) writeFileSync(cbm, JSON.stringify({ ...s, ...v })); return s.projects.map((x) => x.name).sort(); };
  return { id, root, p, repo, wt, td, branch, pp, cleanup, item, indexes };
}

test("resolve: report and library home first, then the declared, dependency and index resources go", () => {
  const f = fixture();
  write(join(f.wt, "node_modules", ".package-lock.json"), "{}\n");
  write(join(f.wt, "node_modules", "dep", "index.js"), "x\n");
  write(join(f.td, "library", "rec", "demo.gif"), "GIF89a finished\n");
  for (let i = 0; i < 3; i++) write(join(f.td, "library", "rec", "frames", `${i}.png`), "frame\n");
  const scratch = mkdtempSync(join(TMP, `${f.id}-scratch-`));
  write(join(scratch, "a.bin"), "tmp\n");
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [
    { path: "library/rec/frames", product: "library/rec/demo.gif", why: "raw frames of demo.gif" },
    { path: scratch, why: "test scratch" },
  ] }));
  const other = mkdtempSync(join(TMP, "t-other-"));
  f.indexes({ projects: [
    { name: "wt-index", root_path: f.wt }, { name: "wt-sub-index", root_path: join(f.wt, "packages") },
    { name: "main-checkout", root_path: f.repo }, { name: `other-${f.id}`, root_path: join(other, f.id) },
    { name: "scratch-index", root_path: scratch },
  ] });

  const res = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(res.ok, res.out);
  assert.match(res.out, /worktree removed/);
  // Archived first: the report and the finished GIF are home, the raw frames were not carried there.
  assert.match(readFileSync(f.p.path("threads", `${f.id}.md`), "utf8"), /final/);
  assert.equal(readFileSync(f.p.path("library", f.id, "rec", "demo.gif"), "utf8"), "GIF89a finished\n");
  assert.ok(!existsSync(f.p.path("library", f.id, "rec", "frames")));
  // Then removed: worktree (with its reinstallable node_modules) through git, the scratch folder, owned indexes.
  assert.ok(!existsSync(f.wt));
  assert.ok(!git(f.repo, "worktree", "list").includes(f.wt));
  assert.ok(git(f.repo, "branch", "--list", f.branch).includes(f.branch), "the branch keeps the commits");
  assert.ok(!existsSync(scratch));
  assert.deepEqual(f.indexes(), ["main-checkout", `other-${f.id}`]);
  const c = f.cleanup();
  assert.equal(c.state, "complete");
  assert.equal(f.item("worktree").status, "removed");
  assert.ok(f.item("worktree").kib >= 0);
  assert.equal(f.item("index", "main-checkout"), undefined);
  assert.match(readFileSync(f.p.path("threads", `${f.id}.cleanup.md`), "utf8"), /wt-index/);

  // A retry and a second resolve change nothing and lose no history.
  const again = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(again.ok, again.out);
  assert.equal(f.cleanup().state, "complete");
  assert.equal(f.item("worktree").status, "removed");
  assert.equal(f.item("index", "wt-index").status, "removed");
  const twice = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(!twice.ok);
  assert.match(twice.out, /thread cleanup demo/);
  rmSync(other, { recursive: true, force: true });
});

test("resolve keeps a worktree with unknown ignored or untracked content, and says why", () => {
  const f = fixture();
  write(join(f.wt, "out", "x", "trace.log"), "evidence\n");
  f.indexes({ projects: [{ name: "wt-index", root_path: f.wt }] });
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /worktree kept: .*out\//);
  assert.equal(readFileSync(join(f.wt, "out", "x", "trace.log"), "utf8"), "evidence\n");
  assert.deepEqual(f.indexes(), ["wt-index"], "an index of a kept worktree stays");
  assert.equal(f.item("worktree").status, "kept");

  const g = fixture();
  write(join(g.wt, "notes.txt"), "mine\n");
  write(join(g.wt, "node_modules", "dep", "index.js"), "no install metadata\n");
  const r2 = g.pp("thread", "resolve", "demo", g.id);
  assert.match(r2.out, /untracked: notes\.txt/);
  assert.match(r2.out, /node_modules\//);
  assert.ok(existsSync(join(g.wt, "notes.txt")));
});

test("keep-worktree and a declared keep survive sweep and retries", () => {
  const f = fixture();
  assert.ok(f.pp("thread", "resolve", "demo", f.id, "--keep-worktree").ok);
  assert.ok(existsSync(f.wt));
  const s = f.pp("sweep", "demo", "--yes");
  assert.ok(s.ok, s.out);
  assert.ok(existsSync(f.wt), s.out);
  f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(existsSync(f.wt));
  assert.match(f.item("worktree").reason, /keep-worktree/);

  const g = fixture();
  write(join(g.td, "cleanup.json"), JSON.stringify({ keep: [{ path: ".", why: "the user wants to look at it" }] }));
  const r = g.pp("thread", "resolve", "demo", g.id);
  assert.match(r.out, /worktree kept: .*the user wants to look at it/);
  rmSync(join(g.td, "cleanup.json")); // the recorded declaration still holds on a retry
  g.pp("thread", "cleanup", "demo", g.id);
  assert.ok(existsSync(g.wt));
});

test("declared paths outside the thread, through a link, or without an archived product are kept", () => {
  const f = fixture();
  const outside = mkdtempSync(join(BASE, "outside-"));
  write(join(outside, "keep.txt"), "not the thread's\n");
  const foreign = mkdtempSync(join(TMP, "t-0001-")); // another thread's id
  symlinkSync(outside, join(f.td, "library", "esc"));
  symlinkSync(outside, join(f.td, "library", "via"));
  mkdirSync(join(outside, "frames"));
  write(join(f.td, "library", "raw", "0.png"), "frame\n");
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [
    { path: "library/esc", product: "library/raw/0.png" },
    { path: "library/via/frames", product: "library/raw/0.png" },
    { path: foreign },
    { path: "library/raw" }, // inside the library without a product
  ] }));
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(r.ok, r.out);
  const reasons = f.cleanup().items.filter((i) => i.kind === "discard").map((i) => `${i.status} ${i.reason}`);
  assert.equal(reasons.length, 4);
  assert.ok(reasons.every((x) => x.startsWith("kept ")), reasons.join("\n"));
  assert.match(reasons.join("\n"), /symbolic link/);
  assert.match(reasons.join("\n"), /not inside/);
  assert.match(reasons.join("\n"), /product/);
  assert.ok(existsSync(join(outside, "keep.txt")) && existsSync(join(outside, "frames")) && existsSync(foreign));
  assert.ok(existsSync(join(f.td, "library", "raw", "0.png")));
  rmSync(foreign, { recursive: true, force: true });
});

test("a worktree in use is kept; the retry removes it once it is free", async () => {
  const f = fixture();
  const sleeper = spawn("sleep", ["60"], { cwd: f.wt, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = f.pp("thread", "resolve", "demo", f.id);
    assert.match(r.out, new RegExp(`worktree kept: .*in use by pid ${sleeper.pid}`));
    assert.ok(existsSync(f.wt));
  } finally { sleeper.kill(); }
  await new Promise((r) => sleeper.exitCode !== null || sleeper.signalCode ? r() : sleeper.on("exit", r));
  const again = f.pp("thread", "cleanup", "demo", f.id);
  assert.match(again.out, /worktree removed/);
  assert.ok(!existsSync(f.wt));
});

test("submodules: a populated one keeps the worktree, an empty one does not", () => {
  const sub = mkdtempSync(join(BASE, "sub-"));
  git(sub, "init", "-q"); git(sub, "commit", "-q", "--allow-empty", "-m", "s");
  const f = fixture();
  git(f.wt, "submodule", "add", "-q", sub, "s"); git(f.wt, "commit", "-qm", "sub");
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.match(r.out, /worktree kept: .*submodule s/);
  assert.ok(existsSync(join(f.wt, "s", ".git")));

  const g = fixture();
  git(g.wt, "submodule", "add", "-q", sub, "s"); git(g.wt, "commit", "-qm", "sub");
  git(g.repo, "worktree", "remove", "--force", g.wt); // a fresh checkout of that commit: the submodule stays empty
  git(g.repo, "worktree", "add", "-q", g.wt, g.branch);
  write(join(g.td, "report.md"), "## Report\nfinal\n");
  const r2 = g.pp("thread", "resolve", "demo", g.id);
  assert.match(r2.out, /worktree removed/, r2.out);
});

test("a folder git does not see as this worktree (rev-parse falls back to the parent) is kept", () => {
  const f = fixture({ inRepo: true });
  rmSync(join(f.wt, ".git"));
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.match(r.out, /worktree kept: .*top level/);
  assert.ok(existsSync(join(f.td, "report.md")));
});

test("an index that fails to delete leaves the thread resolved and partial; the retry finishes", () => {
  const f = fixture();
  f.indexes({ projects: [{ name: "wt-index", root_path: f.wt }], failDelete: true });
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /index wt-index failed/);
  assert.equal(JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")).status, "resolved");
  assert.equal(f.cleanup().state, "partial");
  assert.ok(!existsSync(f.wt));
  f.indexes({ failDelete: false });
  f.pp("thread", "cleanup", "demo", f.id);
  assert.equal(f.cleanup().state, "complete");
  assert.equal(f.item("index", "wt-index").status, "removed");
  assert.equal(f.item("worktree").status, "removed");
  assert.deepEqual(f.indexes(), []);
});

test("a retry keeps the earlier removal on record when the worktree path goes through a link (/tmp on macOS)", () => {
  const f = fixture();
  const link = join(BASE, `link-${f.id}`);
  symlinkSync(dirname(f.wt), link);
  const td = join(link, "wt", ".paseo-project", `demo-${f.id}`);
  const rec = JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8"));
  writeFileSync(f.p.path("threads", `${f.id}.json`), JSON.stringify({ ...rec, cwd: join(link, "wt"), thread_dir: td }));
  write(join(f.td, "library", "demo.gif"), "GIF\n");
  write(join(f.td, "library", "frames", "0.png"), "frame\n");
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: "library/frames", product: "library/demo.gif" }] }));
  assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
  assert.equal(f.item("discard").status, "removed");
  f.pp("thread", "cleanup", "demo", f.id);
  assert.deepEqual(f.cleanup().items.filter((i) => i.kind === "discard").map((i) => i.status), ["removed"]);
  assert.equal(f.item("worktree").status, "removed");
});

// Review of PR #1: the four reachable gaps.

test("a declaration cannot reach another thread's folder, its ancestors, or a folder holding one", () => {
  const f = fixture();
  const other = join(f.wt, ".paseo-project", "demo-t-0002");
  write(join(other, "report.md"), "another thread's report\n");
  const holder = mkdtempSync(join(TMP, `${f.id}-holder-`));
  write(join(holder, "wt", ".paseo-project", "x-t-0003", "report.md"), "another\n");
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: "../demo-t-0002" }, { path: ".." }, { path: holder }] }));
  const r = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(r.ok, r.out);
  const ds = f.cleanup().items.filter((i) => i.kind === "discard");
  assert.deepEqual(ds.map((i) => i.status), ["kept", "kept", "kept"], r.out);
  assert.ok(ds.every((i) => /thread folder/.test(i.reason)), ds.map((i) => i.reason).join("\n"));
  assert.ok(existsSync(join(other, "report.md")) && existsSync(join(holder, "wt", ".paseo-project", "x-t-0003", "report.md")));
  rmSync(holder, { recursive: true, force: true });
});

test("a missing path never makes an index this thread's; a failed registration removal is failed", () => {
  const f = fixture();
  const foreign = join(BASE, `foreign-${f.id}`); // not there, and never the thread's
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: foreign }] }));
  f.indexes({ projects: [{ name: "foreign-index", root_path: join(foreign, "x") }] });
  assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
  assert.equal(f.item("discard").status, "skipped");
  assert.deepEqual(f.indexes(), ["foreign-index"]);

  const g = fixture();
  git(g.repo, "worktree", "lock", g.wt); // `git worktree remove` without --force refuses a locked one
  rmSync(g.wt, { recursive: true, force: true });
  g.indexes({ projects: [{ name: "wt-index", root_path: g.wt }] });
  const r = g.pp("thread", "resolve", "demo", g.id);
  assert.match(r.out, /worktree failed/, r.out);
  assert.equal(g.cleanup().state, "partial");
  assert.deepEqual(g.indexes(), ["wt-index"]);
});

test("a declared keep protects every overlapping discard, in temp folders and tab threads too", () => {
  const f = fixture();
  const scratch = mkdtempSync(join(TMP, `${f.id}-scratch-`));
  write(join(scratch, "qa", "result.json"), "{}\n");
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: scratch }], keep: [{ path: join(scratch, "qa"), why: "QA result" }] }));
  f.pp("thread", "resolve", "demo", f.id);
  assert.equal(f.item("discard").status, "kept");
  assert.ok(existsSync(join(scratch, "qa", "result.json")));
  rmSync(scratch, { recursive: true, force: true });

  const g = fixture();
  const tab = mkdtempSync(join(BASE, "tab-"));
  const td = join(tab, ".paseo-project", `demo-${g.id}`);
  write(join(td, "report.md"), "## Report\nfinal\n");
  write(join(tab, "out", "keep", "a.txt"), "keep\n");
  write(join(td, "cleanup.json"), JSON.stringify({ discard: [{ path: "../../out" }], keep: [{ path: "../../out/keep" }] }));
  const rec = JSON.parse(readFileSync(g.p.path("threads", `${g.id}.json`), "utf8"));
  writeFileSync(g.p.path("threads", `${g.id}.json`), JSON.stringify({ ...rec, kind: "tab", repo: "", branch: "", cwd: tab, thread_dir: td }));
  assert.ok(g.pp("thread", "resolve", "demo", g.id).ok);
  assert.equal(g.item("discard").status, "kept");
  assert.ok(existsSync(join(tab, "out", "keep", "a.txt")));
});

test("an index rooted at a link into the main checkout is not the thread's, even once the link is gone", () => {
  const f = fixture();
  const scratch = mkdtempSync(join(TMP, `${f.id}-scratch-`));
  symlinkSync(f.repo, join(scratch, "main-link"));
  symlinkSync(join(BASE, `moved-away-${f.id}`), join(scratch, "dangling")); // where it pointed is not known
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: scratch }] }));
  f.indexes({ projects: [
    { name: "main-via-link", root_path: join(scratch, "main-link") }, { name: "via-dangling", root_path: join(scratch, "dangling", "x") },
    { name: "scratch-index", root_path: scratch }, { name: "scratch-sub", root_path: join(scratch, "not-made-yet") },
  ] });
  assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
  assert.ok(!existsSync(scratch) && existsSync(join(f.repo, "package.json")));
  assert.deepEqual(f.indexes(), ["main-via-link", "via-dangling"]);
  f.pp("thread", "cleanup", "demo", f.id);
  assert.deepEqual(f.indexes(), ["main-via-link", "via-dangling"]);
});

test("a failed index retry deletes it while its root still resolves as before, not once the path points into the main checkout", () => {
  const firstRunFails = () => {
    const f = fixture();
    const scratch = mkdtempSync(join(TMP, `${f.id}-scratch-`));
    write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: scratch }] }));
    f.indexes({ projects: [{ name: "idx", root_path: join(scratch, "index") }], failDelete: true });
    assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
    assert.ok(!existsSync(scratch));
    assert.equal(f.item("index", "idx").status, "failed");
    f.indexes({ failDelete: false });
    return { ...f, scratch, deletes: () => readFileSync(join(f.root, "cbm.json.log"), "utf8").split("\n").filter((l) => l.startsWith("delete_project")).length };
  };

  const f = firstRunFails();
  f.pp("thread", "cleanup", "demo", f.id);
  assert.equal(f.item("index", "idx").status, "removed");
  assert.equal(f.cleanup().state, "complete");
  assert.deepEqual(f.indexes(), []);

  const g = firstRunFails();
  mkdirSync(join(g.repo, "index"));
  symlinkSync(g.repo, g.scratch); // the same root string now resolves into the main checkout
  const tried = g.deletes();
  const r = g.pp("thread", "cleanup", "demo", g.id);
  assert.equal(g.deletes(), tried, r.out);
  assert.deepEqual(g.indexes(), ["idx"]);
  assert.equal(g.item("index", "idx").status, "kept", r.out);
  assert.ok(existsSync(join(g.repo, "package.json")));
  rmSync(g.scratch);
});

// Paseo's daemon.autoArchiveAfterMerge archives a merged workspace with deletePaseoWorktree: `git worktree
// remove --force`, `rm -rf`, `git worktree prune`, whatever pp decided. These run exactly that on the fixture.
const paseoArchives = (f) => { git(f.repo, "worktree", "remove", "--force", f.wt); git(f.repo, "worktree", "prune"); };

test("a kept worktree that Paseo's merge auto-archive removed is recorded gone on the retry, not kept", () => {
  for (const flags of [["--keep-worktree"], []]) {
    const f = fixture();
    if (!flags.length) write(join(f.td, "cleanup.json"), JSON.stringify({ keep: [{ path: ".", why: "the user wants to look at it" }] }));
    const r = f.pp("thread", "resolve", "demo", f.id, ...flags);
    assert.equal(f.item("worktree").status, "kept", r.out);
    paseoArchives(f);
    const again = f.pp("thread", "cleanup", "demo", f.id);
    assert.ok(again.ok, again.out);
    assert.equal(f.item("worktree").status, "gone", again.out);
    assert.match(again.out, /worktree was already gone/);
  }
});

test("a managed thread's kept worktree says what Paseo's merge auto-archive will do, unknown when the daemon cannot say", async () => {
  const says = { down: /is unknown \(no Paseo daemon answered/, reject: /is unknown \(permission denied/, malformed: /is unknown \(Response validation failed/, on: /autoArchiveAfterMerge is on/, off: null };
  for (const [mode, want] of Object.entries(says)) {
    const d = await fakeDaemon(mode);
    try {
      const f = fixture({ daemon: d.url });
      for (const args of [["resolve", "demo", f.id, "--keep-worktree"], ["cleanup", "demo", f.id]]) {
        const r = f.pp("thread", ...args);
        assert.ok(r.ok, `${mode} ${args[0]}: ${r.out}`);
        assert.equal(JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")).status, "resolved");
        const wt = f.item("worktree");
        assert.equal(wt.status, "kept", `${mode} ${args[0]}`);
        if (want) { assert.match(wt.reason, want, `${mode} ${args[0]}`); assert.match(r.out, want); }
        else assert.doesNotMatch(wt.reason, /autoArchiveAfterMerge/, `${mode} ${args[0]}`);
      }
      assert.equal(f.cleanup().run, 2);
    } finally { d.stop(); }
  }
});

test("a managed thread folder Paseo removed before resolve: report and library said missing, the cleanup still complete", async () => {
  const d = await fakeDaemon("on");
  try {
    for (const reportHome of [false, true]) {
      const f = fixture({ daemon: d.url });
      if (reportHome) write(f.p.path("threads", `${f.id}.md`), "## Report\nearlier\n");
      paseoArchives(f);
      for (const args of [["resolve", "demo", f.id], ["cleanup", "demo", f.id]]) {
        const r = f.pp("thread", ...args);
        assert.ok(r.ok, r.out);
        assert.match(r.out, reportHome ? /thread folder was already gone: library not copied home; the report home is pp's last copy/ : /thread folder was already gone: report and library not copied home/);
        const c = f.cleanup();
        assert.equal(c.state, "complete");
        assert.equal(c.archive, "missing");
        assert.deepEqual(c.archive_missing, reportHome ? ["library"] : ["report", "library"]);
        assert.match(readFileSync(f.p.path("threads", `${f.id}.cleanup.md`), "utf8"), /archive \*\*missing\*\*/);
        assert.equal(f.item("worktree").status, "gone");
      }
      assert.equal(existsSync(f.p.path("threads", `${f.id}.md`)), reportHome);
      assert.ok(!existsSync(f.p.path("library", f.id)));
    }
  } finally { d.stop(); }
});

test("doctor says the daemon's merge auto-archive is on, or that it could not read it, never silent", async () => {
  const says = { on: /autoArchiveAfterMerge is on/, off: null, reject: /autoArchiveAfterMerge could not be read \(permission denied/, malformed: /autoArchiveAfterMerge could not be read \(Response validation failed/, down: /the local Paseo daemon does not answer/ };
  for (const [mode, want] of Object.entries(says)) {
    const d = await fakeDaemon(mode);
    try {
      const root = mkdtempSync(join(BASE, "doctor-"));
      const r = spawnSync(process.execPath, [PP, "--root", root, "doctor"], { encoding: "utf8", env: { ...process.env, PASEO_URL: d.url }, timeout: 45_000 });
      const out = `${r.stdout}${r.stderr}${r.error ? `\n${r.error.message}` : ""}`;
      if (want) assert.match(out, want, `${mode}: ${out}`);
      else assert.doesNotMatch(out, /autoArchiveAfterMerge/, `${mode}: ${out}`);
    } finally { d.stop(); }
  }
});

test("a retry after pp archived and removed the worktree does not call the archive missing", () => {
  const f = fixture();
  write(join(f.td, "library", "a.txt"), "kept home\n");
  assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
  assert.equal(f.cleanup().archive, "complete");
  const r = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(r.ok, r.out);
  assert.doesNotMatch(r.out, /not copied home/);
  assert.equal(f.cleanup().archive, "complete");
});

test("a library copy that failed part way, then the folder gone: the archive is unknown, never complete", () => {
  const f = fixture();
  write(join(f.td, "library", "a.txt"), "a\n");
  write(join(f.td, "library", "b.txt"), "b\n");
  chmodSync(join(f.td, "library", "b.txt"), 0); // rsync copies a.txt, fails on b.txt
  const first = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(!first.ok, first.out);
  assert.match(first.out, /final copy failed/);
  assert.ok(existsSync(f.p.path("library", f.id, "a.txt")) && !existsSync(f.p.path("library", f.id, "b.txt")));
  paseoArchives(f);
  for (const args of [["resolve", "demo", f.id], ["cleanup", "demo", f.id]]) {
    const r = f.pp("thread", ...args);
    assert.ok(r.ok, r.out);
    assert.match(r.out, /thread folder was already gone: whether the library home is complete is unknown/);
    assert.equal(f.cleanup().archive, "unknown", args[0]);
    assert.deepEqual(f.cleanup().archive_unknown, ["library"]);
  }
});

test("an old cleanup record without an archive field does not prove the library came home complete", () => {
  const f = fixture();
  write(join(f.td, "library", "a.txt"), "a\n");
  assert.ok(f.pp("thread", "resolve", "demo", f.id).ok);
  assert.equal(f.item("worktree").status, "removed");
  // As pp wrote it before it recorded the archive: `resolve --force` also removed worktrees whose library was not copied.
  const { archive, ...old } = f.cleanup();
  writeFileSync(f.p.path("threads", `${f.id}.cleanup.json`), JSON.stringify(old));
  const r = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /whether the library home is complete is unknown/);
  assert.equal(f.cleanup().archive, "unknown");
});

test("pp archive leaves the project active when the daemon does not answer, not archived with live agents", () => {
  const f = fixture();
  const r = f.pp("archive", "demo");
  assert.ok(!r.ok, r.out);
  assert.match(r.out, /no Paseo daemon answered/);
  assert.equal(f.p.status, "active");
});

// One ticker pass in its own process, `gh` faked: the pull request is merged.
const FAKE_GH_DIR = join(BASE, "fake-gh");
write(join(FAKE_GH_DIR, "gh"), `#!/usr/bin/env node
const a = process.argv.slice(2);
console.log(a[0] === "pr" && a[1] === "view" ? process.env.FAKE_GH_VIEW : a[0] === "api" ? "me" : "[]");
`);
chmodSync(join(FAKE_GH_DIR, "gh"), 0o755);
const ORCH = join(dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");
const TICK = join(BASE, "tick.mjs");
writeFileSync(TICK, `const { tick } = await import(${JSON.stringify(pathToFileURL(join(ORCH, "ticker.mjs")).href)});
const { Project } = await import(${JSON.stringify(pathToFileURL(join(ORCH, "project.mjs")).href)});
await tick(new Project(process.argv[2], "demo"), process.argv[3]);
process.exit(0);
`);
const tickOnce = (f, started, view) => new Promise((ok) => {
  const env = { ...process.env, PATH: `${FAKE_GH_DIR}:${process.env.PATH}`, PASEO_URL: NO_DAEMON, PP_CODEBASE_MEMORY_BIN: FAKE_CBM, FAKE_GH_VIEW: JSON.stringify(view) };
  const c = spawn(process.execPath, [TICK, f.root, started], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => c.kill(), 120_000);
  c.on("exit", (code) => { clearTimeout(timer); ok({ code, out }); });
});

test("the ticker resolves no merged or idle thread while the daemon that says whether its agent works does not answer", async () => {
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();
  const merged = fixture(), idle = fixture();
  const url = "https://github.com/o/r/pull/7";
  for (const [f, extra] of [[merged, { origin: "https://github.com/o/r", last_state_change: new Date().toISOString() }], [idle, { last_state_change: old, last_report_change: old }]]) {
    const path = f.p.path("threads", `${f.id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), agent_id: "agent-maybe-working", report_hash: "h", acked_report_hash: "h", ...extra }));
    write(f.p.path("threads", `${f.id}.progress.json`), JSON.stringify({ percent: 100, activity: "done", reported_at: Math.floor(Date.now() / 1000) }));
    write(f.p.path("threads", `${f.id}.md`), `${f === merged ? `PR: ${url}\n\n` : ""}## Report\ndone\n`);
    writeSettings(f.p, { ...f.p.settings(), mute: true, nudge: false });
  }
  const view = { state: "MERGED", reviewDecision: "", statusCheckRollup: [], comments: [], reviews: [], headRefName: merged.branch, headRefOid: "abc", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } };
  const runs = await Promise.all([tickOnce(merged, old, view), tickOnce(idle, old, view)]);
  for (const r of runs) assert.equal(r.code, 0, r.out);
  const now = (f) => ({ status: JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")).status, worktree: existsSync(f.wt) });
  assert.deepEqual({ merged: now(merged), idle: now(idle) }, { merged: { status: "open", worktree: true }, idle: { status: "open", worktree: true } }, runs.map((r) => r.out).join("\n"));
  assert.equal(JSON.parse(readFileSync(merged.p.path("threads", `${merged.id}.json`), "utf8")).pr_state, "MERGED");
});

test("--dry-run previews with the same checks and deletes nothing", () => {
  const f = fixture();
  const scratch = mkdtempSync(join(TMP, `${f.id}-scratch-`));
  write(join(f.td, "cleanup.json"), JSON.stringify({ discard: [{ path: scratch }] }));
  f.indexes({ projects: [{ name: "wt-index", root_path: f.wt }] });
  const r = f.pp("thread", "cleanup", "demo", f.id, "--dry-run");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /worktree would be removed/);
  assert.match(r.out, new RegExp(`${scratch} would be removed`));
  assert.match(r.out, /index wt-index would be removed/);
  assert.ok(existsSync(f.wt) && existsSync(scratch));
  assert.deepEqual(f.indexes(), ["wt-index"]);
  assert.ok(!existsSync(f.p.path("threads", `${f.id}.cleanup.json`)));
  assert.ok(!f.pp("thread", "cleanup", "demo", f.id).ok, "a real run needs a resolved thread");
  rmSync(scratch, { recursive: true, force: true });
});
