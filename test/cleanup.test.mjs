// Resolve-time cleanup, end to end through the CLI: an isolated pp root, a throwaway repo and worktree
// per case, and a fake codebase-memory-mcp. No Paseo daemon (the records have no agent), no real index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = realpathSync(tmpdir());
const BASE = mkdtempSync(join(TMP, "pp-cleanup-"));
process.env.PP_CONFIG = join(BASE, "config.json");
const { create } = await import("../orchestrator/project.mjs");
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

const G = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"];
const git = (cwd, ...a) => execFileSync("git", [...G, "-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
let n = 9100;

/** A project with one open worktree thread on a fresh repo, its brief folder and report in place. */
function fixture({ inRepo = false } = {}) {
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
  const record = { id, title: "x", status: "open", error: "", kind: "worktree", repo, origin: "", branch, base: "", machine: "", cwd: wt, thread_dir: td, agent_id: "", workspace_id: "", profile: "", provider: "", created: new Date().toISOString(), updated: "", last_state: "", last_state_change: "", last_group: "", report_hash: "", last_report_change: "", last_review_item_hash: "", acked_report_hash: "", pr: "", pr_state: "", pr_review: "", resolved_reason: "", kept_worktree: false, session: null };
  writeFileSync(p.path("threads", `${id}.json`), JSON.stringify(record));
  const cbm = join(root, "cbm.json");
  writeFileSync(cbm, JSON.stringify({ projects: [] }));
  const env = { ...process.env, PP_CODEBASE_MEMORY_BIN: FAKE_CBM, FAKE_CBM_STATE: cbm };
  const pp = (...args) => {
    const r = spawnSync(process.execPath, [PP, "--root", root, ...args], { encoding: "utf8", env });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
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
