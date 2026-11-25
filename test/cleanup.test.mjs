// Resolve-time cleanup, end to end through the CLI: an isolated pp root, a throwaway repo and worktree
// per case, and a fake codebase-memory-mcp. No real Paseo daemon (a fake one for records with a workspace), no real index.
import { test } from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const TMP = realpathSync(tmpdir());
const BASE = mkdtempSync(join(TMP, "pp-cleanup-"));
process.env.PP_CONFIG = join(BASE, "config.json");
const { Project, create, writeSettings } = await import("../orchestrator/project.mjs");
const inbox = await import("../orchestrator/inbox.mjs");
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

// A real private Git checkout behind OVNFS's CLI contract, so guards run without a filesystem mount in CI.
const FAKE_OVNFS = join(BASE, "ovnfs");
writeFileSync(FAKE_OVNFS, `#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const state = process.env.FAKE_OVNFS_STATE;
const saved = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : null;
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (args[0] === "--json" && args[1] === "ls") {
  console.log(JSON.stringify({ checkouts: saved?.source === args[2] ? [saved] : [] }));
} else if (args[0] === "--json" && args[1] === "new" && !saved && args[3] === "--name" && args[5]?.startsWith("--rev=")) {
  const source = args[2], name = args[4], path = join(dirname(state), name);
  const rev = git("-C", source, "rev-parse", "--verify", args[5].slice(6));
  git("clone", "--no-checkout", "--", source, path);
  git("-C", path, "checkout", "--detach", rev);
  git("-C", path, "config", "ovnfs.checkout", name);
  const c = { name, path: realpathSync(path), source, created: new Date().toISOString(), git: true };
  writeFileSync(state, JSON.stringify(c));
  console.log(JSON.stringify({ checkout: c }));
} else {
  console.error("unexpected ovnfs invocation", args);
  process.exit(1);
}
`);
chmodSync(FAKE_OVNFS, 0o755);

const NO_DAEMON = "ws://127.0.0.1:1/ws";
const FAKE_DAEMON = fileURLToPath(new URL("./fixtures/fake-paseo.mjs", import.meta.url));
async function fakeDaemon(mode, projectFile = "", existingCwd = "") {
  if (mode === "down") return { url: NO_DAEMON, stop: () => {} };
  const child = spawn(process.execPath, [FAKE_DAEMON], { env: { ...process.env, FAKE_DAEMON_MODE: mode, FAKE_PASEO_PROJECT: projectFile, FAKE_PASEO_EXISTING_CWD: existingCwd }, stdio: ["ignore", "pipe", "inherit"] });
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
  const record = { id, title: "x", status: "open", error: "", kind: "worktree", repo, origin: "", branch, branch_start: { name: branch, oid: git(repo, "rev-parse", "HEAD") }, base: "", machine: "", cwd: wt, thread_dir: td, agent_id: "", workspace_id: daemon ? `wks_${id}` : "", profile: "", provider: "", created: new Date().toISOString(), updated: "", last_state: "", last_state_change: "", last_group: "", report_hash: "", last_report_change: "", last_review_item_hash: "", acked_report_hash: "", pr: "", pr_state: "", pr_review: "", resolved_reason: "", kept_worktree: false, session: null };
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
  return { id, root, p, repo, wt, td, branch, env, pp, cleanup, item, indexes };
}

test("explicit OVNFS refuses an unavailable pinned backend before allocating a thread", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const before = readdirSync(f.p.path("threads"));
  const config = join(f.root, "config.json");
  write(config, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } }));
  Object.assign(f.env, { PP_CONFIG: config, PATH: `${BASE}:${f.env.PATH}`, FAKE_OVNFS_STATE: join(f.root, "absent") });
  const r = f.pp("thread", "start", "demo", "--title", "Unavailable OVNFS", "--task", "test", "--kind", "ovnfs", "--repo", f.repo, "--profile", "fake");
  assert.equal(r.ok, false, r.out);
  assert.match(r.out, /OVNFS v0\.8\.0/);
  assert.deepEqual(readdirSync(f.p.path("threads")), before);
});

const FAKE_OVN_ADMIN = join(BASE, "fake-ovn-admin.mjs");
write(FAKE_OVN_ADMIN, `import { createServer } from "node:net";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
const [state, mount, behavior] = process.argv.slice(2);
const socket = join(state, "admin.sock"), checkouts = [], snapshots = [];
const meta = { version: 5, proto: "nfs", port: 0, mount, state };
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const contents = new Map();
let hideDerived;
const checkIntent = (where, value) => {
  const dir = readFileSync(join(state, "intent"), "utf8");
  const intents = readdirSync(dir).filter((n) => /^t-[0-9]+\\.json$/.test(n)).flatMap((n) => {
    const t = JSON.parse(readFileSync(join(dir, n), "utf8"));
    return [t.working_copy, ...(t.working_copies ?? [])].filter((w) => w?.owner === t.id);
  });
  const matches = intents.filter((w) => w.phase === "creating" && w.ovnfs[where] === value);
  if (matches.length !== 1) throw new Error("expected one preexisting owned intention for " + value);
};
const server = createServer((client) => {
  let buf = Buffer.alloc(0);
  const send = (msg) => { const data = Buffer.from(JSON.stringify(msg)), size = Buffer.alloc(4); size.writeUInt32LE(data.length); client.write(Buffer.concat([size, data])); };
  client.on("error", () => {});
  client.on("data", (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE()) {
      const end = 4 + buf.readUInt32LE(), m = JSON.parse(buf.subarray(4, end)); buf = buf.subarray(end);
      const ok = (data) => send({ id: m.id, ok: data });
      if (m.hello) { send({ welcome: { ...meta, ops: ["status", "ls", "new", "snap", "apply", "rm"], features: behavior === "no-rm-guarantees" ? [] : ["rm.sticky_snapshots", "rm.keep_commits"] } }); continue; }
      appendFileSync(join(state, "calls"), JSON.stringify(m) + "\\n");
      if (m.status) ok({ ...meta, socket, pid: process.pid, build_version: "v0.8.0" });
      else if (m.ls) {
        const discovery = join(state, "discovery");
        const extra = existsSync(discovery) ? JSON.parse(readFileSync(discovery, "utf8")) : {};
        ok({ checkouts: [...checkouts.filter((c) => c.name !== hideDerived), ...(extra.checkouts ?? [])], snapshots: [...snapshots, ...(extra.snapshots ?? [])] });
        hideDerived = undefined;
      }
      else if (m.new) {
        const { name, snapshot } = m.new, path = join(mount, name), gd = join(state, "git", name);
        checkIntent("name", name);
        const input = snapshot && contents.get(snapshot);
        if (snapshot ? (!input || m.new.dir || m.new.rev || m.new.rules || m.new.take) : (!m.new.dir || !m.new.rev)) throw new Error("unsafe new");
        const dir = input?.source ?? m.new.dir, rev = input?.rev ?? m.new.rev;
        mkdirSync(join(state, "git"), { recursive: true });
        git("clone", "--template=", "--no-checkout", "--no-hardlinks", "--", dir, path);
        git("-C", path, "remote", "remove", "origin");
        git("-C", path, "checkout", "--detach", rev);
        if (behavior === "seed-byte-mismatch") {
          const file = join(path, "package.json");
          writeFileSync(file, readFileSync(file, "utf8").replace(/\\n/g, "\\r\\n"));
        }
        if (input) for (const f of readdirSync(input.disk)) cpSync(join(input.disk, f), join(path, f), { recursive: true });
        git("-C", path, "config", "ovnfs.checkout", name);
        renameSync(join(path, ".git"), gd);
        if (input) writeFileSync(join(gd, "pp-working-copy"), input.generation);
        writeFileSync(join(path, ".git"), "gitdir: " + gd + "\\n");
        const c = { name, path, source: dir, base: input?.base ?? "base-capture-" + (checkouts.length + 1), parent: snapshot, created: new Date().toISOString(), git: true };
        const objects = join(state, "bases", c.base, "objects");
        if (!existsSync(objects)) { mkdirSync(dirname(objects), { recursive: true }); renameSync(join(gd, "objects"), objects); }
        else rmSync(join(gd, "objects"), { recursive: true });
        symlinkSync(objects, join(gd, "objects"));
        checkouts.push(c);
        if (input && behavior === "interrupted-derived") hideDerived = name;
        if (behavior === "ambiguous-new") client.destroy(); else ok({ checkout: c });
      } else if (m.snap) {
        const { checkout, label } = m.snap, c = checkouts.find((c) => c.name === checkout);
        checkIntent("label", label);
        if (!c || !m.snap.wait) throw new Error("unexpected snapshot input");
        const id = "s" + (snapshots.length + 1), disk = join(state, id);
        const row = { id, checkout, label, created: new Date().toISOString(), parent: snapshots.filter((s) => s.checkout === checkout).at(-1)?.id ?? c.parent };
        mkdirSync(disk);
        for (const f of readdirSync(c.path).filter((n) => n !== ".git")) cpSync(join(c.path, f), join(disk, f), { recursive: true });
        const generation = readFileSync(join(state, "git", c.name, "pp-working-copy"));
        contents.set(id, { disk, source: c.source, base: c.base, generation, rev: git("-C", c.path, "rev-parse", "HEAD") });
        snapshots.push(row);
        if (behavior !== "pending-snap") row.tree = "tree-" + id;
        else setTimeout(() => { row.tree = "tree-" + id; }, 1500);
        if (behavior.includes("-snap")) client.destroy(); else ok({ snapshot: row });
      } else if (m.apply) {
        const { checkout, branch } = m.apply, c = checkouts.find((c) => c.name === checkout);
        if (!c || !/^pp-preserved-[0-9a-f-]+$/.test(branch) || Object.keys(m.apply).length !== 2) throw new Error("unsafe apply");
        const commit = git("-C", c.path, "rev-parse", "HEAD");
        if (behavior !== "missing-applied-ref") git("-C", c.source, "fetch", "--no-tags", "--quiet", c.path, "HEAD:refs/heads/" + branch);
        ok({ source: c.source, applied: [], merged: [], conflicts: [], branch, commit });
      } else if (m.rm) {
        const i = checkouts.findIndex((c) => c.name === m.rm.checkout);
        if (i < 0 || !m.rm.keep_commits || !m.rm.sticky_snapshots) throw new Error("unsafe rm");
        const c = checkouts[i];
        const tip = git("-C", c.path, "rev-parse", "HEAD"), origin = git("-C", c.source, "rev-parse", "HEAD");
        if (behavior === "refuse-rm" || (tip !== origin && !git("-C", c.source, "for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes").split("\\n").includes(tip))) {
          send({ id: m.id, error: { code: "invalid", message: "cannot keep unique commits" } }); continue;
        }
        const [row] = checkouts.splice(i, 1);
        if (behavior !== "partial-rm") rmSync(row.path, { recursive: true });
        rmSync(join(state, "git", row.name), { recursive: true });
        if (behavior === "lost-rm-reply") client.destroy();
        else ok({});
      } else send({ id: m.id, error: { code: "invalid", message: "unexpected op" } });
    }
  });
});
server.listen(socket, () => { chmodSync(socket, 0o600); console.log("ready"); });
`);

async function managedOvnfsFixture(t, mode = "ambiguous-new", daemon = "before-launch", namespace = "env") {
  // `namespace` "file": no OVNFS_* in PP's environment; the fakes know the paths, so PP must find them through the
  // root's saved namespace, the way an Agent launched by Paseo has to.
  const projectFile = join(BASE, `managed-ovnfs-project-${n}`);
  const d = await fakeDaemon(daemon, projectFile);
  t.after(d.stop);
  const f = fixture({ daemon: d.url });
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  write(projectFile, f.repo);
  const bin = join(f.root, "bin"), state = join(f.root, "s"), mount = join(f.root, "mnt");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(mount);
  write(join(state, "intent"), f.p.path("threads"));
  const executable = (name, source) => { const p = join(bin, name); write(p, `#!${process.execPath}\n${source}`); chmodSync(p, 0o755); };
  executable("ovnfs", `if (process.argv.slice(2).join(" ") === "--json version") console.log(JSON.stringify({ version: "v0.8.0", os: "darwin" })); else process.exit(1);`);
  executable("ps", `console.log("ovnfs serve --no-git-remotes");`);
  const paths = namespace === "file" ? `{ OVNFS_STATE: ${JSON.stringify(state)}, OVNFS_MOUNT: ${JSON.stringify(mount)} }` : "process.env";
  executable("lsof", `import { existsSync, readFileSync } from "node:fs"; const { OVNFS_STATE } = ${paths}; const file = OVNFS_STATE + "/occupied"; process.stdout.write("p12345\\0\\nfcwd\\0n" + (existsSync(file) ? readFileSync(file, "utf8") : "/") + "\\0\\n");`);
  executable("nfsstat", `import { existsSync } from "node:fs"; const { OVNFS_STATE: s, OVNFS_MOUNT: m } = ${paths}; console.log(JSON.stringify(existsSync(s + "/unmounted") ? {} : { nfs: { "Mount Point": m, "Current mount parameters": { "NFS parameters": ["vers=3", "ticotsord", "port=" + s + "/nfs.sock", "mountport=" + s + "/nfs.sock"] } } }));`);
  const admin = spawn(process.execPath, [FAKE_OVN_ADMIN, state, mount, mode], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => admin.kill());
  await Promise.race([once(admin.stdout, "data"), once(admin, "exit").then(() => { throw new Error("fake OVNFS admin exited"); })]);
  const config = join(f.root, "config.json");
  write(config, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } }));
  Object.assign(f.env, { PP_CONFIG: config, PATH: `${bin}:${f.env.PATH}` });
  for (const key of ["OVNFS_STATE", "OVNFS_MOUNT"]) {
    if (namespace === "env") f.env[key] = { OVNFS_STATE: state, OVNFS_MOUNT: mount }[key];
    else delete f.env[key]; // not even an inherited one
  }
  return { ...f, state, mount, next: `t-${Number(f.id.slice(2)) + 1}`,
    start: (...args) => f.pp("thread", "start", "demo", "--title", "Managed OVNFS", "--task", "test", "--kind", "ovnfs", "--repo", f.repo, "--profile", "fake", ...args),
    show: (id) => JSON.parse(f.pp("--json", "thread", "show", "demo", id).out),
    calls: () => readFileSync(join(state, "calls"), "utf8").trim().split("\n").map(JSON.parse) };
}

test("managed OVNFS submits the original repository and exact committed revision without a PP capture", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  const baseline = git(f.repo, "rev-parse", "HEAD");
  write(join(f.repo, "package.json"), "dirty dummy content\n");
  write(join(f.repo, "untracked.txt"), "nonignored untracked file\n");
  const started = f.start(); assert.ok(started.ok, started.out);
  const w = f.show(f.next).working_copy;
  const rpc = f.calls().find((x) => x.new).new;
  assert.equal(w.baseline, baseline);
  assert.equal(w.source, f.repo);
  assert.deepEqual(rpc, { dir: f.repo, name: w.ovnfs.name, rev: baseline });
  assert.equal(w.ovnfs.capture, undefined);
  assert.equal(w.cache, undefined);
  assert.equal(existsSync(join(f.root, ".pp-working-copy-inputs")), false);
  assert.equal(readFileSync(join(w.path, "package.json"), "utf8"), "{}\n");
  assert.equal(existsSync(join(w.path, "untracked.txt")), false);
  assert.equal(readFileSync(join(f.repo, "package.json"), "utf8"), "dirty dummy content\n");
});

test("managed OVNFS passes tracked links and clean matching submodules to the native checkout", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  const sub = join(f.root, "submodule");
  git(f.root, "clone", "--", f.repo, sub);
  git(f.repo, "-c", "protocol.file.allow=always", "submodule", "add", "--", sub, "vendor/child");
  symlinkSync("package.json", join(f.repo, "tracked-link"));
  git(f.repo, "add", "tracked-link"); git(f.repo, "commit", "-qm", "link and submodule");
  const started = f.start(); assert.ok(started.ok, started.out);
  const w = f.show(f.next).working_copy;
  assert.equal(readlinkSync(join(w.path, "tracked-link")), "package.json");
  assert.deepEqual(f.calls().find((m) => m.new).new.take, [".:vendor/child"]);
  write(join(f.repo, "vendor/child/package.json"), "dirty\n");
  const dirty = f.start(); assert.ok(dirty.ok, dirty.out);
  assert.equal(f.calls().filter((m) => m.new).at(-1).new.take, undefined);
});

test("managed OVNFS preference uses Git for explicit dirty seeds without allocating OVNFS", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.pp("set", "demo", "repos.policy", `${f.repo}=ovnfs-preferred`).ok);
  write(join(f.repo, "package.json"), '{"dirty":true}\n');
  const refused = f.start("--inherit-dirty");
  assert.equal(refused.ok, false, refused.out);
  assert.match(refused.out, /requires a local git-worktree/);
  const started = f.pp("thread", "start", "demo", "--title", "Dirty seed", "--task", "test", "--repo", f.repo, "--profile", "fake", "--inherit-dirty");
  assert.ok(started.ok, started.out);
  assert.match(started.out, /--inherit-dirty uses a git-worktree/);
  const w = f.show(f.next).working_copy;
  assert.equal(w.backend, "git-worktree");
  assert.equal(readFileSync(join(w.path, "package.json"), "utf8"), '{"dirty":true}\n');
  assert.equal(existsSync(join(f.state, "calls")), false);
});

test("managed OVNFS reconciles an ambiguous allocation before Agent start and never reallocates", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t);
  assert.ok(f.pp("set", "demo", "working_copy_policy", "ovnfs-preferred").ok);
  const r = f.pp("thread", "start", "demo", "--title", "Policy OVNFS", "--task", "test", "--repo", f.repo, "--profile", "fake");
  assert.equal(r.ok, false, r.out);
  assert.match(r.out, /workspace lookup refused/);
  assert.doesNotMatch(r.out, /fell back/);
  const failed = f.show(f.next);
  assert.equal(failed.working_copy.backend, "ovnfs");
  assert.equal(failed.working_copy.selection, undefined);
  assert.equal(failed.working_copy.owner, f.next);
  assert.equal(failed.working_copy.phase, "ready");
  assert.equal(failed.cwd, join(f.mount, f.calls().find((x) => x.new).new.name));
  write(join(f.state, "unmounted"), "fake");
  const missing = f.pp("thread", "restart", "demo", f.next);
  assert.equal(missing.ok, false, missing.out);
  assert.match(missing.out, /mount/);
  rmSync(join(f.state, "unmounted"));
  const retry = f.pp("thread", "restart", "demo", f.next);
  assert.ok(retry.ok, retry.out);
  assert.equal(f.show(f.next).cwd, failed.cwd);
  assert.equal(f.calls().filter((entry) => entry.new).length, 1);
  assert.equal(git(f.repo, "branch", "--list", failed.branch), "");
});

test("managed OVNFS restarts and explicitly deletes a checkout after only its saved NFS device changes", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  const resolve = (...args) => f.pp("thread", "resolve", "demo", f.next, ...args);
  assert.ok(resolve().ok);
  assert.ok(resolve("--reopen").ok);
  const path = f.p.path("threads", `${f.next}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")), w = record.working_copy;
  const old = w.identity;
  const [device, inode] = old.directory.split(":");
  const remounted = `${BigInt(device) + 1n}:${inode}`;
  const restart = () => f.pp("thread", "restart", "demo", f.next, "--fresh");
  const setIdentity = (identity) => {
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.working_copy.identity = { ...old, ...identity };
    write(path, JSON.stringify(current));
  };
  for (const identity of [{ directory: `${device}:${BigInt(inode) + 1n}` }, { directory: remounted, registration: "0:1" }, { directory: remounted, created: "2025-01-01T00:00:00.000Z" }]) {
    setIdentity(identity);
    const refused = restart();
    assert.equal(refused.ok, false, refused.out);
    assert.match(refused.out, /checkout identity does not match/);
    assert.equal(f.show(f.next).agent_id, record.agent_id);
  }
  setIdentity({ directory: remounted });
  const mark = join(w.identity.git_dir, "pp-working-copy");
  const generation = readFileSync(mark, "utf8");
  rmSync(mark);
  const missingMarker = restart();
  assert.equal(missingMarker.ok, false, missingMarker.out);
  assert.match(missingMarker.out, /checkout generation does not match/);
  assert.equal(f.show(f.next).agent_id, record.agent_id);
  assert.equal(existsSync(mark), false);
  write(mark, generation);
  const retry = restart();
  assert.ok(retry.ok, retry.out);
  const after = f.show(f.next);
  assert.equal(after.cwd, w.path);
  assert.equal(after.working_copy.nonce, w.nonce);
  assert.equal(after.agent_id, "agent-2");
  assert.equal(f.calls().filter((m) => m.new).length, 1);
  assert.ok(resolve().ok);
  const deleted = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.ok(deleted.ok, deleted.out);
  assert.equal(f.show(f.next).working_copy.phase, "removed");
  assert.equal(f.calls().filter((m) => m.rm).length, 1);
});

test("repos.policy scopes ovnfs-preferred to one local repo and survives later settings writes", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  const other = join(f.root, "other-repo");
  mkdirSync(other); git(other, "init", "-q"); git(other, "commit", "-q", "--allow-empty", "-m", "init");
  assert.ok(f.pp("set", "demo", "repos.add", other).ok);
  const entry = (path) => f.p.settings().repos.find((r) => r.path === path);
  const scoped = f.pp("set", "demo", "repos.policy", `${f.repo}=ovnfs-preferred`);
  assert.ok(scoped.ok, scoped.out);
  assert.equal(entry(f.repo).working_copy_policy, "ovnfs-preferred");
  assert.equal("working_copy_policy" in entry(other), false);
  assert.ok(f.pp("set", "demo", "nudge", "false").ok);
  assert.equal(entry(f.repo).working_copy_policy, "ovnfs-preferred");
  const start = (repo, title) => f.pp("thread", "start", "demo", "--title", title, "--task", "test", "--repo", repo, "--profile", "fake");
  const first = f.next, second = `t-${Number(first.slice(2)) + 1}`;
  const plain = start(other, "Other repo");
  assert.ok(plain.ok, plain.out); assert.doesNotMatch(plain.out, /fell back/);
  assert.equal(f.show(first).working_copy.backend, "git-worktree");
  assert.equal(f.show(first).working_copy.selection, undefined);
  const preferred = start(f.repo, "Scoped OVNFS");
  assert.ok(preferred.ok, preferred.out); assert.doesNotMatch(preferred.out, /fell back/);
  assert.equal(f.show(second).working_copy.backend, "ovnfs");
  assert.equal(f.show(second).working_copy.phase, "ready");
  // A project-wide policy does not leak into a repo pinned back to Git.
  assert.ok(f.pp("set", "demo", "repos.policy", `${f.repo}=git-worktree`).ok);
  assert.ok(f.pp("set", "demo", "working_copy_policy", "ovnfs-preferred").ok);
  const third = `t-${Number(second.slice(2)) + 1}`;
  const pinned = start(f.repo, "Pinned to Git");
  assert.ok(pinned.ok, pinned.out); assert.doesNotMatch(pinned.out, /fell back/);
  assert.equal(f.show(third).working_copy.backend, "git-worktree");
  assert.equal(f.show(third).working_copy.selection, undefined);
  assert.ok(f.pp("set", "demo", "repos.policy", `${f.repo}=off`).ok);
  assert.equal("working_copy_policy" in entry(f.repo), false);
  assert.doesNotMatch(readFileSync(f.p.path("PROJECT.md"), "utf8"), /\[\[repos\]\]\npath = [^\n]+\nworking_copy_policy/); // the project-level line set above is unrelated
  for (const [value, reason] of [[`${join(f.root, "nowhere")}=ovnfs-preferred`, /is not one of the repos/], [`${f.repo}=always`, /repos\.policy takes/]]) {
    const refused = f.pp("set", "demo", "repos.policy", value);
    assert.equal(refused.ok, false, refused.out); assert.match(refused.out, reason);
  }
  const far = join(f.root, "far");
  assert.ok(f.pp("set", "demo", "repos.add", `${far}@elsewhere`).ok);
  const remote = f.pp("set", "demo", "repos.policy", `${far}=ovnfs-preferred`);
  assert.equal(remote.ok, false, remote.out); assert.match(remote.out, /remote repo; it always uses git-worktree/);
  // A hand-written invalid value is reported with its repo and never silently falls back.
  const file = f.p.path("PROJECT.md"), lines = readFileSync(file, "utf8").split("\n");
  lines.splice(lines.indexOf("[[repos]]") + 2, 0, 'working_copy_policy = "always"');
  write(file, lines.join("\n"));
  const invalid = start(f.repo, "Invalid repo policy");
  assert.equal(invalid.ok, false, invalid.out);
  assert.match(invalid.out, /repos\.policy takes git-worktree or ovnfs-preferred/); assert.doesNotMatch(invalid.out, /fell back/);
});

test("a root's saved namespace lets an Agent without OVNFS_* use OVNFS; env still outranks the file", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "before-launch", "file");
  const saved = join(f.root, ".ovnfs.json");
  const start = (title) => f.pp("thread", "start", "demo", "--title", title, "--task", "test", "--repo", f.repo, "--profile", "fake");
  const next = (id) => `t-${Number(id.slice(2)) + 1}`;
  assert.ok(f.pp("set", "demo", "working_copy_policy", "ovnfs-preferred").ok);
  const none = f.pp("working-copy", "ovnfs");
  assert.equal(none.ok, false, none.out); assert.match(none.out, /no OVNFS namespace for/);
  let id = f.next;
  const fell = start("No namespace yet");
  assert.equal(fell.ok, false, fell.out);
  assert.match(fell.out, /fell back to git-worktree/); assert.match(fell.out, /requires an explicit absolute OVNFS_STATE/);
  assert.equal(f.show(id).working_copy.backend, "git-worktree");
  for (const args of [["--state", f.state], ["--mount", f.mount], ["--state", f.state, "--mount", f.mount, "--off"], ["--state", "relative", "--mount", f.mount]]) {
    const refused = f.pp("working-copy", "ovnfs", ...args);
    assert.equal(refused.ok, false, refused.out); assert.equal(existsSync(saved), false, args.join(" "));
  }
  const stored = f.pp("working-copy", "ovnfs", "--state", f.state, "--mount", f.mount);
  assert.ok(stored.ok, stored.out);
  assert.match(stored.out, /saved the OVNFS namespace; OVNFS namespace from .*\.ovnfs\.json: state .*; pinned local daemon verified/);
  assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), { state: f.state, mount: f.mount });
  assert.match(f.pp("working-copy", "ovnfs").out, /OVNFS namespace from .*\.ovnfs\.json: state .*; pinned local daemon verified/);
  // Reconciliation reads the registry for a root that only saved the namespace.
  assert.deepEqual(f.calls().filter((m) => m.ls), []); // the admin status calls came from working-copy ovnfs
  const query = f.pp("thread", "discover", "demo");
  assert.ok(query.ok, query.out); assert.doesNotMatch(query.out, /OVNFS registry unavailable/);
  assert.ok(f.calls().some((m) => m.ls));
  id = next(id);
  const used = start("Saved namespace");
  assert.equal(used.ok, true, used.out); assert.doesNotMatch(used.out, /fell back/);
  const w = f.show(id).working_copy;
  assert.equal(w.backend, "ovnfs"); assert.equal(w.phase, "ready");
  assert.equal(w.ovnfs.namespace.state, realpathSync(f.state));
  assert.ok(f.pp("thread", "resolve", "demo", id, "--skip-copy").ok, "resolve");
  const deleted = f.pp("thread", "delete-checkout", "demo", id);
  assert.ok(deleted.ok, deleted.out);
  assert.equal(f.show(id).working_copy.disposal.phase, "removed");
  assert.equal(f.calls().filter((m) => m.rm).length, 1);
  // A set env pair is used as-is, even when it does not work; the file is not consulted.
  Object.assign(f.env, { OVNFS_STATE: join(f.root, "absent"), OVNFS_MOUNT: f.mount });
  const shadowed = f.pp("working-copy", "ovnfs");
  assert.equal(shadowed.ok, false, shadowed.out);
  assert.match(shadowed.out, /OVNFS_STATE and OVNFS_MOUNT \(set in this environment; they outrank .*\.ovnfs\.json\)/);
  delete f.env.OVNFS_STATE; delete f.env.OVNFS_MOUNT;
  write(saved, JSON.stringify({ state: f.state }));
  const broken = f.pp("working-copy", "ovnfs");
  assert.equal(broken.ok, false, broken.out); assert.match(broken.out, /must hold a JSON object with absolute "state" and "mount"/);
  const removed = f.pp("working-copy", "ovnfs", "--off");
  assert.equal(removed.ok, true, removed.out); // removing is the success; what is left is in the text
  assert.match(removed.out, /removed the saved OVNFS namespace; no OVNFS namespace for/);
  assert.equal(existsSync(saved), false);
  const twice = f.pp("working-copy", "ovnfs", "--off");
  assert.equal(twice.ok, true, twice.out); assert.match(twice.out, /no saved OVNFS namespace to remove; no OVNFS namespace for/); // nothing to remove is not a removal
  id = next(id);
  const again = start("After --off");
  assert.match(again.out, /fell back to git-worktree/);
  assert.equal(f.show(id).working_copy.backend, "git-worktree");
});

test("managed preflight: resource and space pressure refuse additions without disturbing a held OVNFS checkout", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  const record = f.show(f.next).working_copy;
  const hold = f.pp("thread", "hold", "demo", f.next, "--reason", "still active", "--until", "2099-01-01T00:00:00Z");
  assert.ok(hold.ok, hold.out);
  for (const [key, limit, why] of [["working_copy_max_resources", "1", /resource budget/], ["working_copy_min_free_bytes", "9007199254740991", /space warning/]]) {
    const setting = f.pp("set", "demo", key, limit); assert.ok(setting.ok, setting.out);
    const before = readdirSync(f.p.path("threads"));
    for (const action of [() => f.start(), () => f.pp("thread", "experiment", "demo", f.next, "--name", "extra"), () => f.pp("thread", "snapshot", "demo", f.next, "--name", "save")]) {
      const rejected = action(); assert.equal(rejected.ok, false, rejected.out); assert.match(rejected.out, why);
    }
    assert.deepEqual(readdirSync(f.p.path("threads")), before);
    const tick = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(tick.code, 0, tick.out);
    assert.ok(f.pp("set", "demo", key, "off").ok);
  }
  const view = JSON.parse(f.pp("board", "thread", "demo", f.next).out);
  assert.equal(view.working_copy.nonce, record.nonce);
  assert.equal(view.working_copy.retained_input, undefined);
  assert.ok(view.working_copy.blockers.some((s) => /still active/.test(s)));
  assert.ok(existsSync(record.path));
  assert.deepEqual(f.calls().filter((m) => m.new || m.snap || m.rm || m.drop).map((m) => Object.keys(m).filter((k) => k !== "id")), [["new"]]);
});

test("managed OVNFS registers an experiment and snapshots its own checkout before deriving a new owner", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "ambiguous-snap", "off");
  const started = f.start(); assert.ok(started.ok, started.out);
  const experiment = f.pp("thread", "experiment", "demo", f.next, "--name", "scratch");
  assert.ok(experiment.ok, experiment.out);
  const parent = f.show(f.next), ex = parent.working_copies.find((w) => w.resource === "scratch");
  assert.equal(ex.owner, f.next);
  assert.notEqual(ex.path, parent.cwd);
  write(join(ex.path, "experiment.txt"), "the frozen input\n");
  const snap = f.pp("thread", "snapshot", "demo", f.next, "--name", "save", "--resource", "scratch");
  assert.ok(snap.ok, snap.out);
  const snapshot = f.show(f.next).working_copies.find((w) => w.resource === "save");
  assert.equal(snapshot.owner, f.next);
  assert.equal(snapshot.phase, "ready");
  assert.equal(snapshot.depends_on[0], ex.nonce);
  assert.equal(snapshot.identity.checkout, ex.identity.name);
  assert.equal(f.calls().filter((m) => m.snap).length, 1);
  const child = f.start("--from-snapshot", `${f.next}/save`);
  assert.ok(child.ok, child.out);
  const newId = `t-${Number(f.next.slice(2)) + 1}`, derived = f.show(newId).working_copy;
  assert.equal(derived.owner, newId);
  assert.equal(derived.depends_on[0], snapshot.nonce);
  assert.equal(derived.identity.parent, snapshot.identity.id);
  assert.equal(readFileSync(join(derived.path, "experiment.txt"), "utf8"), "the frozen input\n");
  write(join(derived.path, "experiment.txt"), "changed in derived checkout\n");
  assert.equal(readFileSync(join(ex.path, "experiment.txt"), "utf8"), "the frozen input\n");
  assert.equal(existsSync(join(f.repo, "experiment.txt")), false);
  const board = f.pp("board", "thread", "demo", f.next);
  assert.ok(board.ok, board.out);
  assert.equal(JSON.parse(board.out).working_copies.find((w) => w.resource === "save").identity.id, snapshot.identity.id);
});

test("managed OVNFS recovers one interrupted derived allocation and refuses any other generation", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "interrupted-derived", "off");
  assert.ok(f.start().ok);
  assert.ok(f.pp("thread", "snapshot", "demo", f.next, "--name", "save").ok);
  const parent = f.show(f.next).working_copy;
  const failed = f.start("--from-snapshot", `${f.next}/save`);
  assert.equal(failed.ok, false, failed.out);
  assert.match(failed.out, /checkout identity could not be confirmed/);
  const id = `t-${Number(f.next.slice(2)) + 1}`;
  const before = f.show(id);
  assert.equal(before.agent_id, "");
  assert.equal(before.working_copy.phase, "creating");
  const { path, nonce, ovnfs } = before.working_copy;
  const mark = join(f.state, "git", ovnfs.name, "pp-working-copy");
  const inherited = readFileSync(mark, "utf8");
  const restart = () => f.pp("thread", "restart", "demo", id, "--fresh");
  for (const invalid of [`${randomUUID()}\n${parent.identity.initial_oid}\n`, `${parent.nonce}\n${"0".repeat(40)}\n`, null]) {
    if (invalid === null) rmSync(mark);
    else write(mark, invalid);
    const refused = restart();
    assert.equal(refused.ok, false, refused.out);
    assert.match(refused.out, /checkout generation does not match/);
    assert.equal(existsSync(mark) ? readFileSync(mark, "utf8") : null, invalid);
    assert.equal(f.show(id).agent_id, "");
  }
  write(mark, inherited);
  git(path, "branch", before.branch);
  const branchCollision = restart();
  assert.equal(branchCollision.ok, false, branchCollision.out);
  assert.match(branchCollision.out, /already exists/);
  assert.equal(f.show(id).working_copy.phase, "creating");
  assert.equal(f.show(id).agent_id, "");
  assert.equal(readFileSync(mark, "utf8"), `${nonce}\n${parent.identity.initial_oid}\n`);
  git(path, "branch", "-m", before.branch, "retained-fixture-ref");
  const recovered = restart();
  assert.ok(recovered.ok, recovered.out);
  const after = f.show(id);
  assert.equal(after.cwd, path);
  assert.equal(after.working_copy.nonce, nonce);
  assert.equal(after.working_copy.phase, "ready");
  assert.equal(readFileSync(mark, "utf8"), `${nonce}\n${after.working_copy.identity.initial_oid}\n`);
  assert.equal(readFileSync(join(parent.identity.git_dir, "pp-working-copy"), "utf8"), inherited);
  assert.equal(f.calls().filter((m) => m.new).length, 2);
  assert.equal(after.agent_id, "agent-2");
  assert.match(restart().out, /it has an agent/);
});

test("OVNFS auto-resolve, ticker cleanup, manual cleanup and sweep never delete checkouts or snapshots", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start("--reviews", REVIEW_URL).ok);
  const { thread_dir } = f.show(f.next);
  write(join(thread_dir, "report.md"), "## Report\nDone\n");
  assert.ok(f.pp("report", "--thread", `demo/${f.next}`, "--percent", "100").ok);
  const now = new Date().toISOString();
  const views = { [REVIEW_URL]: { state: "MERGED" } };
  for (let i = 0; i < 2; i++) {
    const tick = await tickOnce(f, now, views);
    assert.equal(tick.code, 0, tick.out);
  }
  assert.equal(f.show(f.next).resolved_reason, "reviewed PR merged");
  for (const args of [["thread", "cleanup", "demo", f.next], ["sweep", "demo", "--yes"]]) {
    const r = f.pp(...args);
    assert.ok(r.ok, r.out);
  }
  const { working_copy: w } = f.show(f.next);
  assert.equal(w.disposal.phase, "retained");
  assert.match(w.disposal.blocker, /explicit-only/);
  assert.ok(existsSync(w.path));
  assert.deepEqual(f.calls().filter((m) => m.rm || m.drop), []);
});

test("explicit deletion refuses unresolved, held, snapshot and dependent OVNFS resources", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  const del = (...args) => f.pp("thread", "delete-checkout", "demo", f.next, ...args);
  const refused = (r, reason) => { assert.equal(r.ok, false, r.out); assert.match(r.out, reason); };
  refused(del(), /not resolved/);
  assert.ok(f.pp("thread", "experiment", "demo", f.next, "--name", "scratch").ok);
  assert.ok(f.pp("thread", "snapshot", "demo", f.next, "--name", "save", "--resource", "scratch").ok);
  assert.ok(f.pp("thread", "hold", "demo", f.next, "--reason", "debugging", "--until", "2099-01-01T00:00:00Z").ok);
  const resolved = f.pp("thread", "resolve", "demo", f.next);
  assert.ok(resolved.ok, resolved.out);
  refused(del(), /hold: debugging/);
  refused(del("--resource", "save"), /snapshots are not deletable/);
  refused(del("--resource", "scratch"), /depends on this checkout|depends on this worktree/);
  assert.deepEqual(f.calls().filter((m) => m.rm || m.drop), []);
});

test("explicit deletion refuses occupied, unclassified and registry-dependent OVNFS checkouts without rm", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  const resolved = f.pp("thread", "resolve", "demo", f.next);
  assert.ok(resolved.ok, resolved.out);
  const { working_copy: w } = f.show(f.next);
  const refused = (reason) => { const r = f.pp("thread", "delete-checkout", "demo", f.next); assert.equal(r.ok, false, r.out); assert.match(r.out, reason); };
  write(join(f.state, "occupied"), w.path);
  refused(/occupied by process 12345/);
  rmSync(join(f.state, "occupied"));
  write(join(w.path, "stray.bin"), "unknown\n");
  refused(/unclassified/);
  rmSync(join(w.path, "stray.bin"));
  write(join(f.state, "discovery"), JSON.stringify({ checkouts: [{ name: "external", path: join(f.mount, "external"), source: w.path, base: "b", created: new Date().toISOString(), git: true }] }));
  refused(/checkout external depends on this checkout/);
  assert.deepEqual(f.calls().filter((m) => m.rm || m.drop), []);
  assert.notEqual(f.show(f.next).working_copy.disposal.phase, "unknown");
});

test("resolved OVNFS status rechecks actionable blockers without sending rm or drop", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  assert.ok(f.pp("thread", "resolve", "demo", f.next).ok);
  const view = () => f.show(f.next).working_copy.disposal;
  const { path, nonce } = f.show(f.next).working_copy;
  const tick = async () => {
    const r = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(r.code, 0, r.out);
  };
  write(join(f.state, "occupied"), path);
  await tick();
  assert.match(view().blocker, /occupied by process 12345/);
  rmSync(join(f.state, "occupied"));
  write(join(path, "stray.bin"), "needs classification\n");
  await tick();
  assert.match(view().blocker, /unclassified.*stray.bin/);
  rmSync(join(path, "stray.bin"));
  write(join(f.state, "discovery"), JSON.stringify({ checkouts: [{ name: "external", path: join(f.mount, "external"), source: path, base: "b", created: new Date().toISOString(), git: true }] }));
  await tick();
  assert.match(view().blocker, /checkout external depends on this checkout/);
  rmSync(join(f.state, "discovery"));
  await tick();
  assert.match(view().blocker, /explicit-only/);
  // A status refresh must flag a missing previously recorded proof, not publish a replacement.
  const record = f.p.path("threads", `${f.next}.json`), row = JSON.parse(readFileSync(record));
  row.working_copy.disposal.evidence = { path: f.p.path("disposal-evidence", nonce), manifest: "a".repeat(64), bundle: "b".repeat(64) };
  write(record, JSON.stringify(row));
  await tick();
  assert.match(view().blocker, /evidence.*(?:missing|verified)|ENOENT/);
  assert.ok(!existsSync(f.p.path("disposal-evidence")));
  assert.deepEqual(f.calls().filter((m) => m.rm || m.drop), []);
});

test("explicit OVNFS deletion accepts a ready checkout whose Agent was never dispatched", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "before-launch");
  const started = f.start();
  assert.equal(started.ok, false, started.out);
  assert.match(started.out, /workspace lookup refused/);
  const row = f.show(f.next);
  assert.equal(row.agent_id, "");
  assert.equal(row.working_copy.phase, "ready");
  assert.ok(f.pp("thread", "resolve", "demo", f.next, "--skip-copy").ok);
  const deleted = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.ok(deleted.ok, deleted.out);
  assert.equal(f.show(f.next).working_copy.disposal.phase, "removed");
  assert.equal(f.calls().filter((m) => m.rm).length, 1);
});

test("explicit deletion refuses a backend without non-force snapshot-preserving rm before recording removal", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "no-rm-guarantees", "off");
  assert.ok(f.start().ok);
  assert.ok(f.pp("thread", "resolve", "demo", f.next).ok);
  const r = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.equal(r.ok, false, r.out);
  assert.match(r.out, /retained: .*does not support non-force, snapshot-preserving OVNFS removal/);
  assert.notEqual(f.show(f.next).working_copy.disposal.phase, "unknown");
  assert.deepEqual(f.calls().filter((m) => m.rm), []);
});

test("an Agent can explicitly delete one resolved managed OVNFS checkout with verified evidence", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  assert.ok(f.pp("thread", "experiment", "demo", f.next, "--name", "scratch").ok);
  const { working_copy: w } = f.show(f.next);
  const output = join(f.show(f.next).thread_dir, "library", "result.txt");
  write(output, "result\n");
  git(w.path, "commit", "--allow-empty", "-qm", "private result");
  const tip = git(w.path, "rev-parse", "HEAD");
  write(join(f.show(f.next).thread_dir, "cleanup.json"), JSON.stringify({ commits: [tip] }));
  git(f.repo, "fetch", "--no-tags", w.path, `HEAD:refs/remotes/origin/${w.branch}`);
  const sourceRefs = git(f.repo, "show-ref");
  const resolved = f.pp("thread", "resolve", "demo", f.next);
  assert.ok(resolved.ok, resolved.out);
  assert.ok(existsSync(w.path));
  assert.deepEqual(f.calls().filter((m) => m.apply || m.rm), []);
  const deleted = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.ok(deleted.ok, deleted.out);
  assert.match(deleted.out, /OVNFS checkout removed/);
  const { working_copy: gone, working_copies: [scratch] } = f.show(f.next);
  assert.equal(gone.disposal.phase, "removed");
  assert.ok(existsSync(scratch.path));
  assert.ok(!existsSync(w.path));
  assert.ok(!existsSync(w.identity.git_dir));
  const evidence = gone.disposal.evidence.path;
  assert.equal(readFileSync(join(evidence, "files", relative(w.path, output)), "utf8"), "result\n");
  const restored = join(f.root, "restored.git");
  git(f.root, "clone", "--mirror", join(evidence, "commits.bundle"), restored);
  assert.equal(git(restored, "rev-parse", `refs/heads/saved/${tip}`), tip);
  assert.equal(git(f.repo, "show-ref"), sourceRefs);
  assert.deepEqual(f.calls().filter((m) => m.apply || m.rm).map(({ apply, rm }) => apply ?? rm), [
    { checkout: w.identity.name, keep_commits: true, sticky_snapshots: true },
  ]);
});

test("OVNFS explicit deletion retains declared commits that are not reachable from the source", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  const started = f.start(); assert.ok(started.ok, started.out);
  const { working_copy: w, thread_dir: td } = f.show(f.next);
  git(w.path, "commit", "--allow-empty", "-qm", "private result");
  const tip = git(w.path, "rev-parse", "HEAD"), refs = git(f.repo, "show-ref");
  write(join(td, "cleanup.json"), JSON.stringify({ commits: [tip] }));
  const resolved = f.pp("thread", "resolve", "demo", f.next); assert.ok(resolved.ok, resolved.out);
  const deleted = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.equal(deleted.ok, false, deleted.out);
  assert.match(deleted.out, /retained: .*not present in the source repository/);
  assert.ok(existsSync(w.path));
  assert.equal(f.show(f.next).working_copy.disposal.phase, "retained");
  assert.equal(git(f.repo, "show-ref"), refs);
  assert.deepEqual(f.calls().filter((m) => m.apply || m.rm), []);
});

test("OVNFS explicit deletion refuses linked private Git metadata", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "off", "off");
  assert.ok(f.start().ok);
  const { working_copy: w } = f.show(f.next);
  const resolved = f.pp("thread", "resolve", "demo", f.next); assert.ok(resolved.ok, resolved.out);
  const heads = join(w.identity.git_dir, "refs", "heads"), outside = join(f.root, "external-refs");
  renameSync(heads, outside);
  const refs = readdirSync(outside);
  symlinkSync(outside, heads, "dir");
  const deleted = f.pp("thread", "delete-checkout", "demo", f.next);
  assert.equal(deleted.ok, false, deleted.out);
  assert.match(deleted.out, /retained: unclassified OVNFS private Git entry: refs\/heads/);
  assert.ok(existsSync(w.path));
  assert.deepEqual(readdirSync(outside), refs);
  assert.deepEqual(f.calls().filter((m) => m.apply || m.rm), []);
});

for (const [mode, reason] of [["refuse-rm", /cannot keep unique commits/], ["partial-rm", /not confirmed by registry and filesystem/], ["lost-rm-reply", / closed| EOF|empty response/i]]) {
  test(`OVNFS explicit deletion reports ${mode} and never repeats an uncertain rm`, { skip: process.platform !== "darwin" }, async (t) => {
    const f = await managedOvnfsFixture(t, mode, "off");
    assert.ok(f.start().ok);
    const del = () => f.pp("thread", "delete-checkout", "demo", f.next);
    const resolve = f.pp("thread", "resolve", "demo", f.next);
    assert.ok(resolve.ok, resolve.out);
    const result = del();
    assert.equal(result.ok, false, result.out);
    assert.match(result.out, /removal unconfirmed/);
    assert.match(result.out, reason);
    const { working_copy: w } = f.show(f.next);
    assert.equal(w.disposal.phase, "unknown");
    const cleanup = f.pp("thread", "cleanup", "demo", f.next);
    assert.ok(cleanup.ok, cleanup.out);
    assert.equal(f.show(f.next).working_copy.disposal.phase, "unknown");
    if (mode === "lost-rm-reply") {
      write(join(f.state, "unmounted"), "1");
      const unmounted = del();
      assert.equal(unmounted.ok, false, unmounted.out);
      assert.match(unmounted.out, /mount/);
      rmSync(join(f.state, "unmounted"));
      const retry = del();
      assert.ok(retry.ok, retry.out);
      assert.equal(f.show(f.next).working_copy.disposal.phase, "removed");
    } else {
      const retry = del();
      assert.equal(retry.ok, false, retry.out);
      assert.match(retry.out, /will not send another rm/);
      assert.ok(existsSync(w.path));
    }
    assert.equal(f.calls().filter((m) => m.rm).length, 1);
  });
}

// A legacy OVNFS thread (no working_copy) as earlier pp versions recorded it; `--kind ovnfs` now starts managed ones.
async function ovnfsFixture(mode, fn, extra = {}) {
  const projectFile = join(BASE, `ovnfs-project-${n}`);
  const d = await fakeDaemon(mode, projectFile);
  try {
    const f = fixture({ daemon: d.url });
    write(projectFile, f.repo);
    const config = join(f.root, "config.json");
    write(config, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } }));
    const registry = join(f.root, "ovnfs.json");
    Object.assign(f.env, { PP_CONFIG: config, FAKE_OVNFS_STATE: registry, PATH: `${BASE}:${f.env.PATH}` });
    const base = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "commit", "--allow-empty", "-qm", "next");
    git(f.repo, "remote", "add", "origin", "https://github.com/o/r");
    const id = `t-${Number(f.id.slice(2)) + 1}`;
    const legacy = { ...JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")), id, title: "OVNFS test", status: "failed", kind: "ovnfs", repo: f.repo,
      origin: "https://github.com/o/r", branch: `pp-demo-${id}-ovnfs-test`, base, cwd: "", thread_dir: "", workspace_id: "", profile: "fake", provider: "claude/fake-model", ovnfs_name: `pp-${randomUUID()}`, ...extra };
    writeFileSync(f.p.path("threads", `${id}.json`), JSON.stringify(legacy));
    writeFileSync(f.p.path("threads", `${id}.task.md`), "test\n");
    const r = f.pp("thread", "restart", "demo", id);
    assert.ok(r.ok, r.out);
    const thread = () => JSON.parse(readFileSync(f.p.path("threads", `${id}.json`), "utf8"));
    const t = thread();
    assert.equal(git(t.cwd, "rev-parse", "HEAD"), base);
    assert.equal(git(t.cwd, "branch", "--show-current"), t.branch);
    assert.equal(t.workspace_id, "wks_ovnfs_0");
    assert.equal(git(f.repo, "branch", "--list", t.branch), "");
    await fn({ ...f, id, t, thread, registry });
  } finally { d.stop(); }
}

test("legacy OVNFS resolve, cleanup and sweep retain the checkout and even standalone declared discards", async () => {
  await ovnfsFixture("archive-retry", ({ p, pp, id, t, thread, registry }) => {
    const restarted = pp("thread", "restart", "demo", id, "--fresh");
    assert.ok(restarted.ok, restarted.out);
    assert.equal(thread().cwd, t.cwd);
    assert.equal(thread().workspace_id, t.workspace_id);
    assert.notEqual(thread().agent_id, t.agent_id);
    write(join(t.thread_dir, "library", "result.txt"), "archived output\n");
    const scratch = mkdtempSync(join(TMP, `${id}-ovn-discard-`));
    try {
      write(join(scratch, "discard.txt"), "keep legacy discard\n");
      write(join(t.thread_dir, "cleanup.json"), JSON.stringify({ discard: [{ path: scratch, why: "legacy scratch" }] }));
      const preview = pp("thread", "cleanup", "demo", id, "--dry-run");
      assert.ok(preview.ok, preview.out);
      assert.doesNotMatch(preview.out, /would be removed/);
      assert.ok(existsSync(scratch));
      const first = pp("thread", "resolve", "demo", id);
      assert.ok(first.ok, first.out);
      assert.match(first.out, /agent archive refused/);
      assert.match(first.out, /OVNFS checkout kept/);
      assert.equal(readFileSync(p.path("library", id, "result.txt"), "utf8"), "archived output\n");
      const retry = pp("thread", "cleanup", "demo", id);
      assert.ok(retry.ok, retry.out);
      assert.match(retry.out, /agent archived/);
      assert.match(retry.out, /legacy OVNFS.*retained/);
      const sweep = pp("sweep", "demo", "--yes");
      assert.ok(sweep.ok, sweep.out);
      const explicit = pp("thread", "delete-checkout", "demo", id);
      assert.equal(explicit.ok, false, explicit.out);
      assert.match(explicit.out, /legacy or external checkout/);
      assert.ok(existsSync(t.cwd));
      assert.ok(existsSync(registry));
      assert.equal(readFileSync(join(scratch, "discard.txt"), "utf8"), "keep legacy discard\n");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

test("legacy OVNFS still archives library changes made before the retained checkout becomes idle", async () => {
  await ovnfsFixture("off", ({ env, p, pp, id, t, root }) => {
    const bin = join(root, "bin");
    const result = join(t.thread_dir, "library", "result.txt");
    const checked = join(root, "checked-occupants");
    write(result, "before\n");
    mkdirSync(bin);
    writeFileSync(join(bin, "lsof"), `#!/usr/bin/env node
const fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(checked)})) {
  const times = fs.statSync(${JSON.stringify(result)});
  fs.writeFileSync(${JSON.stringify(result)}, 'latest\\n');
  fs.utimesSync(${JSON.stringify(result)}, times.atime, times.mtime);
  fs.writeFileSync(${JSON.stringify(checked)}, '1');
  console.log(${JSON.stringify(`p12345\nn${t.cwd}`)});
}
`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const resolved = pp("thread", "resolve", "demo", id);
    assert.ok(resolved.ok, resolved.out);
    assert.match(resolved.out, /legacy OVNFS.*retained/);
    assert.ok(existsSync(t.cwd));
    assert.equal(readFileSync(p.path("library", id, "result.txt"), "utf8"), "latest\n");
  });
});

test("legacy OVNFS final copy still refuses a changed identity", async () => {
  await ovnfsFixture("off", ({ pp, id, t, registry }) => {
    const record = readFileSync(registry, "utf8");
    write(registry, JSON.stringify({ ...JSON.parse(record), created: "replaced" }));
    const mismatch = pp("thread", "resolve", "demo", id);
    assert.equal(mismatch.ok, false, mismatch.out);
    assert.match(mismatch.out, /OVNFS checkout identity changed/);
    assert.ok(existsSync(t.cwd));
  });
});

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

test("an option a command does not declare stops it before any effect: resolve --dry-run resolves nothing", () => {
  const f = fixture();
  write(join(f.wt, "node_modules", ".package-lock.json"), "{}\n");
  const snap = () => JSON.stringify([readFileSync(f.p.path("threads", `${f.id}.json`), "utf8"), existsSync(f.wt), readdirSync(f.p.path("threads")).sort(), readdirSync(f.p.path("inbox") ?? f.root).sort(), existsSync(f.p.path("library", f.id))]);
  const before = snap();
  for (const args of [["thread", "resolve", "demo", f.id, "--dry-run"], ["thread", "resolve", "demo", f.id, "--keep-worktre"], ["thread", "stop", "demo", f.id, "--force"], ["sweep", "demo", "--yes", "--dryrun"]]) {
    const r = f.pp(...args);
    assert.ok(!r.ok, args.join(" "));
    assert.match(r.out, /unknown option/);
  }
  assert.equal(snap(), before, "the thread is still open, its worktree and files are as they were");
  assert.equal(JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")).status, "open");
  // The preview that exists is `thread cleanup --dry-run`, and the documented options still resolve.
  assert.ok(f.pp("thread", "cleanup", "demo", f.id, "--dry-run").ok);
  assert.ok(existsSync(f.wt));
  assert.ok(f.pp("thread", "resolve", "demo", f.id, "--keep-worktree", "--skip-copy", "--force").ok);
  assert.equal(JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`), "utf8")).status, "resolved");
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
  // A gitlink with an uninitialized submodule; keep the registered worktree generation unchanged.
  write(join(g.wt, ".gitmodules"), `[submodule "s"]\n\tpath = s\n\turl = ${sub}\n`);
  git(g.wt, "add", ".gitmodules");
  git(g.wt, "update-index", "--add", "--cacheinfo", `160000,${git(sub, "rev-parse", "HEAD")},s`);
  git(g.wt, "commit", "-qm", "sub");
  mkdirSync(join(g.wt, "s"));
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

test("resolve reports Paseo archive failures and cleanup retries both archives", async () => {
  const d = await fakeDaemon("archive-retry");
  try {
    const f = fixture({ daemon: d.url });
    const path = f.p.path("threads", `${f.id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), agent_id: "agent-for-resolve" }));
    assert.ok(f.pp("thread", "cleanup", "demo", f.id, "--dry-run").ok);

    const first = f.pp("thread", "resolve", "demo", f.id);
    assert.ok(first.ok, first.out);
    assert.match(first.out, /agent not archived: .*agent archive refused/);
    assert.match(first.out, /Paseo workspace not archived: workspace archive refused/);
    assert.equal(existsSync(f.wt), false);

    const second = f.pp("thread", "cleanup", "demo", f.id);
    assert.ok(second.ok, second.out);
    assert.match(second.out, /agent archived/);
    assert.match(second.out, /Paseo workspace archived/);
  } finally { d.stop(); }
});

test("resolve archives the agent and leaves a workspace backed by a kept worktree active", async () => {
  const d = await fakeDaemon("off");
  try {
    const f = fixture({ daemon: d.url });
    const path = f.p.path("threads", `${f.id}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), agent_id: "agent-for-resolve" }));
    write(join(f.td, "cleanup.json"), JSON.stringify({ keep: [{ path: ".", why: "audit evidence" }] }));
    const r = f.pp("thread", "resolve", "demo", f.id);
    assert.ok(r.ok, r.out);
    assert.match(r.out, /agent archived/);
    assert.match(r.out, /Paseo workspace kept: archiving it could delete the worktree/);
    assert.doesNotMatch(r.out, /Paseo workspace archived/);
    assert.ok(existsSync(f.wt));
  } finally { d.stop(); }
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

test("a complete archive does not vouch for the round after reopen and restart: its new library lost is unknown", async () => {
  const d = await fakeDaemon("off");
  try {
    const f = fixture({ daemon: d.url });
    write(join(f.td, "library", "a.txt"), "round 1\n");
    const first = f.pp("thread", "resolve", "demo", f.id);
    assert.ok(first.ok, first.out);
    assert.equal(f.cleanup().archive, "complete");
    assert.ok(!existsSync(f.wt));
    writeFileSync(process.env.PP_CONFIG, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } })); // the isolated config
    for (const args of [["resolve", "demo", f.id, "--reopen"], ["restart", "demo", f.id, "--profile", "fake"]]) { const r = f.pp("thread", ...args); assert.ok(r.ok, r.out); }
    assert.ok(existsSync(join(f.td, "brief.md")), "the restart checked the branch out again");
    write(join(f.td, "library", "b.txt"), "round 2\n");
    paseoArchives(f);
    for (const args of [["resolve", "demo", f.id], ["cleanup", "demo", f.id]]) {
      const r = f.pp("thread", ...args);
      assert.ok(r.ok, r.out);
      assert.match(r.out, /thread folder was already gone: whether the library home is complete is unknown/, args[0]);
      assert.equal(f.cleanup().archive, "unknown", args[0]);
      assert.deepEqual(f.cleanup().archive_unknown, ["library"]);
    }
    assert.ok(!existsSync(f.p.path("library", f.id, "b.txt")));
  } finally { d.stop(); }
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

function terminalResult(f, ...args) {
  const command = [process.execPath, PP, "--root", f.root, ...args];
  const r = spawnSync("python3", ["-I", "-c", "import pty, subprocess, sys\nmaster, terminal = pty.openpty()\nsys.exit(subprocess.call(sys.argv[1:], stdin=terminal))", ...command], {
    encoding: "utf8", env: f.env, timeout: 45_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}${r.error?.message ?? ""}` };
}

function ppAtTerminal(f, ...args) {
  const { status, out } = terminalResult(f, ...args);
  assert.equal(status, 0, out);
}

async function managedFixture(t, mode = "off", withProject = false) {
  const projectFile = withProject ? join(BASE, `managed-project-${n}`) : "";
  const d = await fakeDaemon(mode, projectFile);
  const f = fixture({ daemon: d.url });
  if (projectFile) write(projectFile, f.repo);
  t.after(() => { d.stop(); rmSync(f.root, { recursive: true, force: true }); });
  const config = join(f.root, "config.json");
  write(config, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } }));
  f.env.PP_CONFIG = config;
  f.pp("set", "demo", "mute", "true");
  f.pp("set", "demo", "nudge", "false");
  const id = `t-${Number(f.id.slice(2)) + 1}`;
  const start = (...args) => f.pp("thread", "start", "demo", "--repo", f.repo, "--title", "Managed copy", "--task", "Work here", "--profile", "fake", ...args);
  const query = (...args) => {
    const r = f.pp(...args);
    assert.ok(r.ok, r.out);
    return JSON.parse(r.out);
  };
  return { ...f, id, start, show: (tid = id) => query("thread", "show", "demo", tid, "--json"),
    board: (tid = id) => query("board", "thread", "demo", tid), legacy: f.id };
}

test("resolve from the coordinator directory retains inbox history but only nudges for cleanup problems", async (t) => {
  const f = await managedFixture(t);
  const resolveFrom = (cwd, id) => {
    const r = spawnSync(process.execPath, [PP, "--root", f.root, "thread", "resolve", "demo", id], { cwd, env: f.env, encoding: "utf8", timeout: 45_000 });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}${r.error ?? ""}`);
  };
  const ids = [f.id, `t-${Number(f.id.slice(2)) + 1}`, `t-${Number(f.id.slice(2)) + 2}`];
  for (const id of ids) {
    const started = f.start();
    assert.ok(started.ok, started.out);
    if (id === ids[1]) write(join(f.board(id).cwd, "unclassified.txt"), "must be kept\n");
    resolveFrom(id === ids[2] ? f.root : f.p.dir, id);
  }
  const resolved = (items) => items.filter((i) => i.event === "resolved");
  const history = resolved(inbox.unhandled(f.p));
  assert.deepEqual(history.map((i) => i.subject), ids);
  assert.equal(history[0].silent, true);
  assert.match(history[1].summary, /unclassified.txt/);
  const pending = resolved(inbox.pendingNudges(f.p));
  assert.deepEqual(pending.map((i) => i.subject), ids.slice(1));
  assert.ok(!inbox.nudgeText(pending).includes(ids[0]));
});

test("managed preflight: Git stays default, policy fallback is visible, and actual Git allocations respect the budget", async (t) => {
  const f = await managedFixture(t);
  delete f.env.OVNFS_STATE;
  delete f.env.OVNFS_MOUNT;
  f.env.PATH = `${BASE}:${f.env.PATH}`;
  const start = f.start(); assert.ok(start.ok, start.out); assert.doesNotMatch(start.out, /fell back/);
  assert.equal(f.show().working_copy.backend, "git-worktree");
  const policy = f.pp("set", "demo", "working_copy_policy", "ovnfs-preferred"); assert.ok(policy.ok, policy.out);
  const explicit = f.start("--kind", "ovnfs"); assert.equal(explicit.ok, false, explicit.out);
  assert.doesNotMatch(explicit.out, /fell back/);
  const preferred = f.start(); assert.ok(preferred.ok, preferred.out); assert.match(preferred.out, /fell back to git-worktree/);
  const second = `t-${Number(f.id.slice(2)) + 1}`;
  const w = f.board(second).working_copy;
  assert.equal(w.backend, "git-worktree");
  assert.equal(w.selection.policy, "ovnfs-preferred");
  assert.match(w.selection.reason, /OVNFS/);
  assert.ok(f.pp("set", "demo", "working_copy_max_resources", "2").ok);
  const refused = f.start("--kind", "worktree"); assert.equal(refused.ok, false, refused.out); assert.match(refused.out, /resource budget/);
  assert.equal(f.board().working_copy.phase, "ready");
  assert.equal(f.board(second).working_copy.nonce, w.nonce);
  assert.ok(f.pp("set", "demo", "working_copy_max_resources", "off").ok);
  assert.ok(f.pp("set", "demo", "working_copy_min_free_bytes", "9007199254740991").ok);
  assert.match(f.start("--kind", "worktree").out, /space warning/);
});

test("managed cache: git-worktree revalidates exact declared data and never shares writes", async (t) => {
  const f = await managedFixture(t);
  const start = () => { const r = f.start(); assert.ok(r.ok, r.out); };
  const i = Number((f.next ?? f.id).slice(2));
  const view = (offset) => JSON.parse(f.pp("board", "thread", "demo", `t-${i + offset}`).out).working_copy;
  const hash = (s) => createHash("sha256").update(s).digest("hex");
  const path = f.p.path("working-copy-cache.json");
  const declarations = { [f.repo]: { baseline: git(f.repo, "rev-parse", "HEAD"), root: "node_modules",
    inputs: { "package-lock.json": hash("{}\n") }, files: { "test-cache/value": hash("DUMMY CACHE") } } };
  const update = () => write(path, JSON.stringify(declarations));
  update();
  write(join(f.repo, "node_modules/test-cache/value"), "DUMMY CACHE");
  write(join(f.repo, "node_modules/test-cache/private"), "DUMMY UNDECLARED");
  write(join(f.repo, "node_modules/.env"), "DUMMY CREDENTIAL");
  write(join(f.repo, "out/local"), "DUMMY LOCAL");
  start(); start();
  const a = view(0), b = view(1);
  for (const w of [a, b]) {
    assert.equal(w.cache.state, "reused");
    assert.equal(readFileSync(join(w.path, "node_modules/test-cache/value"), "utf8"), "DUMMY CACHE");
    for (const leaf of ["node_modules/.env", "node_modules/test-cache/private", "out/local"]) assert.equal(existsSync(join(w.path, leaf)), false, leaf);
  }
  write(join(a.path, "node_modules/test-cache/value"), "EDIT ONE COPY");
  assert.equal(readFileSync(join(f.repo, "node_modules/test-cache/value"), "utf8"), "DUMMY CACHE");
  assert.equal(readFileSync(join(b.path, "node_modules/test-cache/value"), "utf8"), "DUMMY CACHE");
  write(join(f.repo, "package-lock.json"), "CHANGED INPUT\n");
  start(); const changed = view(2);
  assert.equal(changed.cache.state, "cold"); assert.match(changed.cache.reason, /input/);
  assert.equal(existsSync(join(changed.path, "node_modules")), false);
  write(join(f.repo, "package-lock.json"), "{}\n");
  rmSync(join(f.repo, "node_modules/test-cache/value"));
  symlinkSync(join(f.repo, "node_modules/.env"), join(f.repo, "node_modules/test-cache/value"));
  start(); const alias = view(3);
  assert.equal(alias.cache.state, "cold");
  assert.equal(existsSync(join(alias.path, "node_modules")), false);
  declarations[f.repo].files = { ".env": hash("DUMMY CREDENTIAL") }; update();
  start(); assert.equal(view(4).cache.state, "cold");
  assert.equal(existsSync(join(view(4).path, "node_modules")), false);
});

test("managed inputs: git-worktree retains an independently restorable explicit dirty seed", async (t) => {
  const f = await managedFixture(t);
  const base = git(f.repo, "rev-parse", "HEAD");
  write(join(f.repo, "package.json"), '{"staged": true}\n');
  git(f.repo, "add", "package.json");
  write(join(f.repo, "package.json"), '{"effective": true}\n');
  rmSync(join(f.repo, "package-lock.json"));
  write(join(f.repo, "local.txt"), "dummy undeclared file");
  write(join(f.repo, "out", ".env"), "dummy credential");
  const status = git(f.repo, "status", "--porcelain");
  const result = f.start("--inherit-dirty"); assert.ok(result.ok, result.out);
  const id = f.next ?? f.id, w = f.show(id).working_copy;
  assert.equal(w.baseline, base);
  assert.notEqual(w.seed.oid, base);
  assert.equal(git(w.path, "rev-parse", "HEAD"), w.seed.oid);
  assert.equal(readFileSync(join(w.path, "package.json"), "utf8"), '{"effective": true}\n');
  assert.equal(existsSync(join(w.path, "package-lock.json")), false);
  assert.equal(existsSync(join(w.path, "local.txt")), false);
  assert.equal(existsSync(join(w.path, "out")), false);
  assert.equal(git(f.repo, "status", "--porcelain"), status);
  write(join(w.path, "package.json"), '{"later": true}\n');
  const saved = join(f.root, "source-moved"); renameSync(f.repo, saved);
  const restored = join(f.root, "restored");
  git(f.root, "clone", "--no-local", "--", w.seed.path, restored);
  assert.equal(git(restored, "rev-parse", "HEAD"), w.seed.oid);
  assert.equal(git(restored, "rev-parse", "HEAD^"), base);
  assert.equal(readFileSync(join(restored, "package.json"), "utf8"), '{"effective": true}\n');
  assert.equal(existsSync(join(restored, "package-lock.json")), false);
});

test("managed inputs: git-worktree restores exact UTF-16LE dirty seed bytes", async (t) => {
  const f = await managedFixture(t);
  const file = "package.json", source = join(f.repo, file);
  write(join(f.repo, ".gitattributes"), `${file} working-tree-encoding=UTF-16LE\n`);
  write(source, Buffer.from('{"base": "a"}\n', "utf16le"));
  git(f.repo, "add", "--", ".gitattributes", file); git(f.repo, "commit", "-qm", "encoded source");
  const edited = Buffer.from('{"edit": "one"}\n', "utf16le");
  write(source, edited);
  const r = f.start("--inherit-dirty"); assert.ok(r.ok, r.out);
  const w = f.show(f.next ?? f.id).working_copy;
  assert.equal(w.phase, "ready");
  assert.ok(readFileSync(join(w.path, file)).equals(edited), "checkout must preserve the working bytes");
  assert.ok(readFileSync(join(w.seed.path, file)).equals(edited), "retained seed must preserve the working bytes");
  assert.ok(readFileSync(source).equals(edited), "source must remain unchanged");
  const restored = join(f.root, "encoded-restored");
  git(f.root, "clone", "--no-local", "--", w.seed.path, restored);
  assert.ok(readFileSync(join(restored, file)).equals(edited), "independent Git restore must preserve the working bytes");
});

test("managed inputs: git-worktree restores CRLF and refuses non-round-tripping LF under eol=crlf", async (t) => {
  const f = await managedFixture(t);
  const file = "package.json", source = join(f.repo, file);
  write(join(f.repo, ".gitattributes"), `${file} text eol=crlf\n`);
  write(source, '{"base": true}\r\n');
  git(f.repo, "add", "--", ".gitattributes", file); git(f.repo, "commit", "-qm", "CRLF source");
  const id = f.next ?? f.id, crlf = Buffer.from('{"crlf": true}\r\n');
  write(source, crlf);
  const first = f.start("--inherit-dirty"); assert.ok(first.ok, first.out);
  const w = f.show(id).working_copy, restored = join(f.root, "crlf-restored");
  git(f.root, "clone", "--no-local", "--", w.seed.path, restored);
  for (const path of [w.path, w.seed.path, restored]) assert.ok(readFileSync(join(path, file)).equals(crlf), "exact CRLF is restorable");

  // Even when canonical content is from HEAD, normalizing edited working bytes
  // on restore is not equivalent to inheriting the requested source.
  const lf = Buffer.from('{"base": true}\n');
  write(source, lf);
  const failed = f.start("--inherit-dirty"); assert.equal(failed.ok, false);
  assert.match(failed.out, /dirty seed does not round-trip to the source working-tree bytes/);
  const next = f.show(`t-${Number(id.slice(2)) + 1}`).working_copy;
  assert.equal(next.phase, "planned"); assert.equal(existsSync(next.path), false);
  assert.ok(readFileSync(source).equals(lf), "refusal preserves the source bytes");
});

test("managed inputs: git-worktree blocks an allocated checkout with changed seed bytes", async (t) => {
  const f = await managedFixture(t);
  const file = "package.json", source = join(f.repo, file), expected = Buffer.from('{"dirty": true}\n');
  write(source, expected);
  // A linked worktree uses local attributes, which must not enter the independent seed.
  write(join(f.repo, ".git/info/attributes"), `${file} text eol=crlf\n`);
  const failed = f.start("--inherit-dirty"); assert.equal(failed.ok, false);
  assert.match(failed.out, /dirty seed does not round-trip.*in the allocated checkout/);
  const id = f.next ?? f.id;
  const w = f.show(id).working_copy;
  assert.equal(w.phase, "creating");
  assert.ok(readFileSync(join(w.seed.path, file)).equals(expected), "retained seed is unaffected by the backend conversion");
  assert.ok(readFileSync(source).equals(expected), "source remains unchanged");
  const retry = f.pp("thread", "restart", "demo", id, "--fresh");
  assert.equal(retry.ok, false); assert.match(retry.out, /dirty seed does not round-trip.*in the allocated checkout/);
  assert.equal(f.show(id).working_copy.nonce, w.nonce);
});

test("managed inputs: ordinary Git filters still work without a verified cache claim", async (t) => {
  const f = await managedFixture(t, "error-first");
  write(join(f.repo, ".gitattributes"), "package.json filter=fixture\n");
  git(f.repo, "add", ".gitattributes"); git(f.repo, "commit", "-qm", "normal checkout filter");
  git(f.repo, "config", "filter.fixture.smudge", "sed 's/^{}/DUMMY &/'");
  git(f.repo, "config", "filter.fixture.clean", "sed 's/^DUMMY //'");
  const baseline = git(f.repo, "rev-parse", "HEAD"), hash = (s) => createHash("sha256").update(s).digest("hex");
  write(join(f.repo, "node_modules/cache.txt"), "DUMMY CACHE");
  write(f.p.path("working-copy-cache.json"), JSON.stringify({ [f.repo]: { baseline, root: "node_modules",
    inputs: { "package-lock.json": hash("{}\n") }, files: { "cache.txt": hash("DUMMY CACHE") } } }));
  const result = f.start(); assert.ok(result.ok, result.out);
  const w = f.board().working_copy;
  assert.equal(w.baseline, baseline); assert.equal(git(w.path, "rev-parse", "HEAD"), baseline);
  assert.equal(readFileSync(join(w.path, "package.json"), "utf8"), "DUMMY {}\n");
  assert.equal(w.cache.state, "cold"); assert.match(w.cache.reason, /checkout filter/);
  assert.equal(existsSync(join(w.path, "node_modules")), false);
  const restarted = f.pp("thread", "restart", "demo", f.id, "--fresh"); assert.ok(restarted.ok, restarted.out);
  assert.equal(f.board().working_copy.nonce, w.nonce);
  assert.ok(f.pp("set", "demo", "working_copy_policy", "ovnfs-preferred").ok);
  const fallback = f.start(); assert.ok(fallback.ok, fallback.out); assert.match(fallback.out, /fell back to git-worktree/);
  const next = f.board(`t-${Number(f.id.slice(2)) + 1}`).working_copy;
  assert.equal(next.baseline, baseline); assert.equal(next.cache.state, "cold");
  assert.equal(readFileSync(join(next.path, "package.json"), "utf8"), "DUMMY {}\n");
});

test("managed inputs: explicit Git dirty seed refuses a configured checkout filter before allocation", async (t) => {
  const f = await managedFixture(t);
  write(join(f.repo, ".gitattributes"), "package.json filter=local-dummy\n");
  git(f.repo, "add", ".gitattributes"); git(f.repo, "commit", "-qm", "checkout filter attribute");
  const marker = join(f.repo, "out", "local-filter-ran");
  write(join(f.repo, "out", "dummy-private"), "DUMMY PRIVATE");
  git(f.repo, "config", "filter.local-dummy.smudge", `touch '${marker}' && printf 'DUMMY PRIVATE'`);
  const before = readdirSync(f.p.path("threads"));
  const result = f.start("--inherit-dirty");
  assert.equal(result.ok, false, "a filesystem-executing checkout filter is not an authorized seed input");
  assert.match(result.out, /checkout filter/); assert.doesNotMatch(result.out, /DUMMY PRIVATE/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(f.p.path("threads")), before);
});

test("managed holds: an agent needs a reason and a valid bound, and cannot release a hold", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const pp = (sub, ...args) => f.pp("thread", sub, "demo", f.id, ...args);
  assert.match(pp("hold", "--reason", "debugging").out, /deadline or condition/);
  assert.match(pp("hold", "--until", "2099-01-01T00:00:00Z").out, /reason/);
  assert.match(pp("hold", "--reason", "debugging", "--until", "2099-02-30T00:00:00Z").out, /valid future UTC deadline/);
  assert.match(pp("hold", "--reason", "debugging", "--until", "2020-01-01T00:00:00Z").out, /valid future UTC deadline/);
  assert.match(pp("hold", "--reason", "debugging", "--indefinite").out, /must be run by a person/);
  assert.match(pp("resolve", "--keep-worktree").out, /must be run by a person/);
  const held = pp("hold", "--reason", "debugging", "--until", "2099-01-01T00:00:00Z");
  assert.ok(held.ok, held.out);
  assert.match(pp("release").out, /must be run by a person/);
  assert.match(pp("hold", "--reason", "shorter", "--until", "2098-01-01T00:00:00Z").out, /active hold/);
  const resolved = pp("resolve");
  assert.ok(resolved.ok, resolved.out);
  const row = f.show();
  assert.equal(row.status, "resolved");
  assert.deepEqual(row.working_copy.hold, { reason: "debugging", until: "2099-01-01T00:00:00.000Z" });
  assert.equal(row.working_copy.disposal.phase, "retained");
  assert.match(row.working_copy.disposal.blocker, /hold: debugging/);
  assert.ok(existsSync(row.cwd));
});

// Kill the CLI immediately after an atomic publication, before its next instruction.
function interruptRename(f, condition) {
  const hook = join(f.root, "interrupt.mjs");
  write(hook, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (${condition}) process.kill(process.pid, "SIGKILL");
};
syncBuiltinESMExports();`);
  f.env.NODE_OPTIONS = `--import=${pathToFileURL(hook)}`;
  return () => delete f.env.NODE_OPTIONS;
}

test("managed worktree: an interrupted creating intent can be resolved without allocating or deleting", async (t) => {
  const f = await managedFixture(t);
  const record = f.p.path("threads", `${f.id}.json`);
  const resume = interruptRename(f, `to === ${JSON.stringify(record)} && JSON.parse(fs.readFileSync(to)).working_copy?.phase === "creating"`);
  assert.equal(f.start().ok, false);
  resume();
  // Emulate waiting for the dead process’s generic project lock to expire.
  utimesSync(f.p.path(".state", ".lock"), new Date(0), new Date(0));
  const worktrees = git(f.repo, "worktree", "list", "--porcelain");
  const planned = f.show().working_copy;
  assert.equal(planned.phase, "creating");
  assert.equal(planned.identity, null);
  assert.ok(!existsSync(planned.path));
  assert.equal(f.pp("thread", "resolve", "demo", f.id).ok, false);
  const finished = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(finished.ok, finished.out);
  assert.match(finished.out, /allocation.*unconfirmed/);
  const tick = await tickOnce(f, new Date().toISOString(), {});
  assert.equal(tick.code, 0, tick.out);
  assert.equal(f.show().status, "resolved");
  assert.equal(f.show().working_copy.phase, "creating");
  assert.equal(git(f.repo, "worktree", "list", "--porcelain"), worktrees);
  assert.ok(!existsSync(planned.path));
});

test("managed disposal: oldest linked HEAD reflog old OID is retained then restored from the bundle", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, branch, thread_dir: td, working_copy: w } = f.show();
  git(cwd, "switch", "--detach", "HEAD");
  git(cwd, "commit", "--allow-empty", "-qm", "detached result");
  const commit = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", branch);
  const reflog = join(w.identity.git_dir, "logs", "HEAD");
  write(reflog, readFileSync(reflog, "utf8").trimEnd().split("\n").at(-1) + "\n");
  assert.ok(readFileSync(reflog, "utf8").startsWith(`${commit} `));
  assert.ok(!git(cwd, "reflog", "show", "--format=%H").includes(commit));
  assert.equal(git(f.repo, "for-each-ref", "--contains", commit), "");
  const retained = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(retained.ok, retained.out);
  assert.ok(existsSync(cwd), retained.out);
  assert.match(retained.out, new RegExp(`commit ${commit} not declared`));
  write(join(td, "cleanup.json"), JSON.stringify({ commits: [commit] }));
  const completeLog = readFileSync(reflog, "utf8");
  write(reflog, completeLog.trimEnd());
  const incomplete = f.pp("thread", "cleanup", "demo", f.id);
  assert.match(incomplete.out, /Git reflog could not be verified/);
  assert.ok(existsSync(cwd), incomplete.out);
  write(reflog, completeLog);
  const removed = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(removed.ok, removed.out);
  assert.ok(!existsSync(cwd), removed.out);
  const restored = join(f.root, "restored.git");
  git(f.root, "clone", "--mirror", join(f.show().working_copy.disposal.evidence.path, "commits.bundle"), restored);
  assert.equal(git(restored, "rev-parse", `refs/heads/saved/${commit}`), commit);
});

test("managed disposal: verifies already published evidence after interrupted record save", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, thread_dir: td } = f.show();
  write(join(td, "report.md"), "independently verified\n");
  const resume = interruptRename(f, `String(from).includes("/.verify-") && String(to).includes("/disposal-evidence/")`);
  assert.equal(f.pp("thread", "resolve", "demo", f.id).ok, false);
  resume();
  const root = f.p.path("disposal-evidence");
  const [name] = readdirSync(root);
  const evidence = join(root, name), bundle = join(evidence, "commits.bundle");
  const original = readFileSync(bundle);
  assert.ok(existsSync(cwd));
  assert.equal(f.show().working_copy.disposal?.evidence, undefined);
  write(bundle, "not a bundle\n");
  const bad = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(bad.ok, bad.out);
  assert.ok(existsSync(cwd), bad.out);
  assert.equal(f.show().working_copy.disposal.evidence, undefined);
  write(bundle, original);
  const retried = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retried.ok, retried.out);
  assert.ok(!existsSync(cwd), retried.out);
  assert.equal(f.show().working_copy.disposal.evidence.path, evidence);
});

for (const recorded of [false, true]) test(`managed disposal: syncs repaired ${recorded ? "recorded" : "unrecorded"} proof before removal`, async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, thread_dir: td } = f.show();
  write(join(td, "report.md"), "report to preserve\n");
  write(join(td, "library", "nested", "output.txt"), "nested output\n");
  const hook = join(f.root, "sync-probe.mjs"), log = join(f.root, "sync-probe.log");
  write(hook, `import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const paths = new Map(), { openSync, closeSync, fsyncSync, appendFileSync } = fs, { spawnSync } = cp;
const note = (...event) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + "\\n");
fs.openSync = (p, ...args) => { const fd = openSync(p, ...args); paths.set(fd, String(p)); return fd; };
fs.closeSync = (fd) => { paths.delete(fd); return closeSync(fd); };
fs.fsyncSync = (fd) => {
  const p = paths.get(fd);
  if (p && p === process.env.PP_TEST_FAIL_SYNC) {
    note("sync failed", p);
    throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
  }
  fsyncSync(fd);
  if (p) note("synced", p);
};
cp.spawnSync = (cmd, args, opts) => {
  if (cmd === "git" && args.includes("worktree") && args.includes("remove")) {
    note("remove");
    if (process.env.PP_TEST_REFUSE_REMOVE) return { status: 42 };
  }
  return spawnSync(cmd, args, opts);
};
syncBuiltinESMExports();`);
  const probe = `--import=${pathToFileURL(hook)}`;
  const resolveThread = () => f.pp("thread", "resolve", "demo", f.id);
  const cleanupThread = () => f.pp("thread", "cleanup", "demo", f.id);
  if (recorded) {
    f.env.NODE_OPTIONS = probe;
    f.env.PP_TEST_REFUSE_REMOVE = "1";
    const first = resolveThread();
    assert.match(first.out, /backend worktree removal failed/);
    delete f.env.PP_TEST_REFUSE_REMOVE;
  } else {
    const resume = interruptRename(f, `String(from).includes("/.verify-") && String(to).includes("/disposal-evidence/")`);
    assert.equal(resolveThread().ok, false);
    resume();
  }
  const root = f.p.path("disposal-evidence");
  const [generation] = readdirSync(root);
  const path = join(root, generation), bundle = join(path, "commits.bundle");
  assert.equal(f.show().working_copy.disposal?.evidence?.path, recorded ? path : undefined);
  const original = readFileSync(bundle);
  // Make the corrupt bytes durable, then repair them without an explicit flush.
  writeFileSync(bundle, "not a bundle\n", { flush: true });
  writeFileSync(bundle, original);
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  const artifacts = Object.keys(manifest.files).map((rel) => join(path, "files", rel));
  assert.ok(artifacts.some((p) => p.endsWith("/nested/output.txt")));
  const expected = new Set([bundle, join(path, "manifest.json"), join(path, "excludes"), ...artifacts, root, dirname(root)]);
  for (const file of artifacts) for (let p = dirname(file); p.startsWith(path + "/"); p = dirname(p)) expected.add(p);
  expected.add(path);
  const events = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  f.env.NODE_OPTIONS = probe;
  for (const failed of [bundle, dirname(artifacts.find((p) => p.endsWith("/nested/output.txt")))]) {
    writeFileSync(log, "");
    f.env.PP_TEST_FAIL_SYNC = failed;
    const blocked = cleanupThread();
    assert.ok(blocked.ok, blocked.out);
    assert.match(blocked.out, /injected fsync failure/);
    assert.ok(existsSync(cwd), blocked.out);
    const trace = events();
    assert.ok(trace.some(([event, p]) => event === "sync failed" && p === failed));
    assert.ok(!trace.some(([event]) => event === "remove"));
  }
  delete f.env.PP_TEST_FAIL_SYNC;
  writeFileSync(log, "");
  const retried = cleanupThread();
  assert.ok(retried.ok && !existsSync(cwd), retried.out);
  const trace = events(), removal = trace.findIndex(([event]) => event === "remove");
  assert.ok(removal >= 0);
  const durable = new Set(trace.slice(0, removal).filter(([event]) => event === "synced").map(([, p]) => p));
  for (const p of expected) assert.ok(durable.has(p), `not synced before removal: ${p}`);
  assert.equal(f.show().working_copy.disposal.evidence.path, path);
});

test("managed disposal: reconciles a precisely labeled Agent after lost launch acknowledgement", async (t) => {
  const f = await managedFixture(t, "lost-launch");
  const started = f.start();
  assert.equal(started.ok, false, started.out);
  assert.match(started.out, /agent create result lost/);
  assert.equal(f.show().agent_id, "");
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /agent archived/);
  assert.equal(f.show().agent_id, "agent-1");
  assert.equal(f.show().working_copy.disposal.phase, "removed");
});

test("managed disposal: an empty Agent lookup does not prove launch never happened", async (t) => {
  const f = await managedFixture(t, "create-retry");
  assert.equal(f.start().ok, false);
  const { cwd } = f.show();
  const retry = f.pp("thread", "restart", "demo", f.id, "--fresh");
  assert.equal(retry.ok, false, retry.out);
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /agent archive unconfirmed/);
  assert.ok(existsSync(cwd));
});

test("managed disposal: private commits need an explicit declaration, then restore with report and product after removal", async (t) => {
  const f = await managedFixture(t);
  const started = f.start();
  assert.ok(started.ok, started.out);
  const { cwd, thread_dir: td } = f.show();
  write(join(cwd, "package.json"), '{"deliverable":true}\n');
  git(cwd, "commit", "-qam", "private result");
  const commit = git(cwd, "rev-parse", "HEAD");
  write(join(td, "report.md"), "final preserved report\n");
  write(join(td, "library", "result.txt"), "preserved artifact\n");
  const retained = f.pp("thread", "resolve", "demo", f.id, "--force");
  assert.ok(retained.ok, retained.out);
  assert.equal(f.show().status, "resolved");
  assert.ok(existsSync(cwd));
  assert.match(retained.out, /commit .*not declared/);
  assert.equal(f.board().working_copy.disposal.phase, "retained");

  write(join(td, "cleanup.json"), JSON.stringify({ commits: [commit] }));
  const removed = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(removed.ok, removed.out);
  assert.ok(!existsSync(cwd), removed.out);
  assert.ok(!git(f.repo, "worktree", "list", "--porcelain").includes(cwd));
  const w = f.show().working_copy;
  assert.deepEqual(f.board().working_copy, w);
  assert.equal(w.phase, "removed");
  const evidence = w.disposal.evidence;
  assert.ok(evidence.path.startsWith(f.p.dir + "/"));
  assert.ok(!evidence.path.startsWith(cwd + "/"));
  const restored = join(f.root, "restored.git");
  git(f.root, "clone", "--mirror", join(evidence.path, "commits.bundle"), restored);
  assert.equal(git(restored, "show", `${commit}:package.json`), '{"deliverable":true}');
  assert.equal(readFileSync(join(evidence.path, "files", relative(cwd, td), "report.md"), "utf8"), "final preserved report\n");
  assert.equal(readFileSync(join(evidence.path, "files", relative(cwd, td), "library", "result.txt"), "utf8"), "preserved artifact\n");
});

test("managed disposal: force and skip-copy do not classify ignored files, tracked edits or abandoned commits", async (t) => {
  const f = await managedFixture(t);
  const started = f.start();
  assert.ok(started.ok, started.out);
  const { cwd, branch, repo, thread_dir: td } = f.show();
  const retained = (pattern, ...cmd) => {
    const result = f.pp("thread", ...cmd, "demo", f.id, ...(cmd[0] === "resolve" ? ["--force", "--skip-copy"] : []));
    assert.ok(result.ok, result.out);
    assert.ok(existsSync(cwd));
    assert.match(f.board().working_copy.disposal.blocker, pattern);
  };
  write(join(cwd, "node_modules", ".package-lock.json"), "{}\n");
  write(join(cwd, "node_modules", "private"), "not a cache\n");
  write(join(cwd, "out", "result.bin"), "\0classified product\n");
  write(join(cwd, "TEMP"), "not inherently disposable\n");
  retained(/unclassified file: TEMP/, "resolve");
  write(join(td, "cleanup.json"), JSON.stringify({ discard: [{ path: join(cwd, "TEMP") }] }));
  retained(/unclassified file: node_modules/, "cleanup");
  const discard = ["TEMP", "node_modules"].map((name) => ({ path: join(cwd, name) }));
  const save = [{ path: join(cwd, "out", "result.bin") }];
  write(join(td, "cleanup.json"), JSON.stringify({ discard, save }));
  write(join(cwd, "package.json"), "modified\n");
  retained(/unclassified Git modifications/, "cleanup");
  git(cwd, "commit", "-qam", "abandoned experiment");
  const abandoned = git(cwd, "rev-parse", "HEAD");
  git(cwd, "reset", "--hard", "HEAD^");
  retained(/commit .*not declared/, "cleanup");
  write(join(td, "cleanup.json"), JSON.stringify({ discard, save, commits: [abandoned] }));
  const baseline = git(cwd, "rev-parse", "HEAD");
  const branchOnly = git(repo, "commit-tree", `${baseline}^{tree}`, "-p", baseline, "-m", "branch-only experiment");
  git(repo, "update-ref", `refs/heads/${branch}`, branchOnly);
  git(repo, "update-ref", `refs/heads/${branch}`, baseline);
  retained(new RegExp(`commit ${branchOnly} not declared`), "cleanup");
  write(join(td, "cleanup.json"), JSON.stringify({ discard, save, commits: [abandoned, branchOnly] }));
  const removed = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(removed.ok, removed.out);
  assert.ok(!existsSync(cwd), removed.out);
  const archive = f.board().working_copy.disposal.evidence.path;
  assert.equal(readFileSync(join(archive, "files", "out", "result.bin"), "utf8"), "\0classified product\n");
  const restored = join(f.root, "restored.git");
  git(f.root, "clone", "--mirror", join(archive, "commits.bundle"), restored);
  assert.equal(git(restored, "show", `${abandoned}:package.json`), "modified");
  assert.equal(git(restored, "log", "-1", "--format=%s", `refs/heads/saved/${branchOnly}`), "branch-only experiment");
});

test("managed disposal: recorded path keeps and --keep-worktree survive cleanup and sweep", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, thread_dir: td } = f.show();
  const declaration = join(td, "cleanup.json");
  const savedDeclaration = f.p.path("threads", `${f.id}.cleanup.json`);
  write(savedDeclaration, JSON.stringify({ declaration: { keep: [{ path: ".", why: "audit" }] } }));
  const resolve = f.pp("thread", "resolve", "demo", f.id, "--force");
  assert.ok(resolve.ok, resolve.out);
  assert.match(f.board().working_copy.disposal.blocker, /explicit path keep/);
  rmSync(savedDeclaration);
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.match(f.board().working_copy.disposal.blocker, /explicit path keep/);
  assert.ok(existsSync(cwd));
  write(declaration, "{}");
  assert.ok(f.pp("thread", "resolve", "demo", f.id, "--reopen").ok);
  ppAtTerminal(f, "thread", "resolve", "demo", f.id, "--keep-worktree", "--force", "--skip-copy");
  const sweep = f.pp("sweep", "demo", "--yes");
  assert.ok(sweep.ok, sweep.out);
  assert.ok(existsSync(cwd));
  assert.match(f.board().working_copy.disposal.blocker, /--keep-worktree hold/);
});

test("managed disposal: backend failure retains prior proof and changed contents get a fresh verified generation", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, thread_dir: td } = f.show();
  const report = join(td, "report.md");
  write(report, "verified report\n");
  const bin = join(f.root, "bin"), realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const mode = join(f.root, "backend-mode");
  write(join(bin, "git"), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
if (args.includes('status') && mode === 'bad-inspection') {
  console.error('cannot inspect checkout files');
  process.exit(0);
}
if (args.includes('worktree') && args.includes('remove')) {
  if (mode === 'noop') process.exit(0);
  if (mode === 'refuse') process.exit(42);
}
const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (args.includes('worktree') && args.includes('remove') && fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'lost-result' && result.status === 0) process.exit(43);
process.exit(result.status ?? 1);
`);
  chmodSync(join(bin, "git"), 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const retry = (pattern) => {
    const result = f.pp("thread", "cleanup", "demo", f.id);
    assert.ok(result.ok, result.out);
    if (pattern) {
      assert.ok(existsSync(cwd), result.out);
      assert.match(f.board().working_copy.disposal.blocker, pattern);
    }
    return result;
  };
  write(mode, "bad-inspection");
  const resolve = f.pp("thread", "resolve", "demo", f.id);
  assert.ok(resolve.ok, resolve.out);
  assert.ok(existsSync(cwd), resolve.out);
  assert.match(f.board().working_copy.disposal.blocker, /cannot inspect checkout files/);
  write(mode, "refuse");
  retry(/backend worktree removal failed/);
  const disposal = f.board().working_copy.disposal;
  assert.equal(disposal.phase, "unknown");
  const proof = disposal.evidence;
  write(mode, "noop");
  retry(/backend removal could not be verified/);
  write(mode, "remove");
  const record = f.p.path("threads", `${f.id}.json`);
  const savedRecord = readFileSync(record, "utf8");
  const incomplete = JSON.parse(savedRecord);
  delete incomplete.working_copy.disposal.evidence;
  write(record, JSON.stringify(incomplete));
  renameSync(proof.path, `${proof.path}.backup`);
  retry(/previous disposal has no verified evidence/);
  assert.ok(!existsSync(proof.path));
  renameSync(`${proof.path}.backup`, proof.path);
  write(record, savedRecord);
  const saved = join(proof.path, "files", relative(cwd, report));
  const bundle = join(proof.path, "commits.bundle"), original = readFileSync(bundle);
  rmSync(bundle);
  retry(/evidence missing or corrupt: commits.bundle/);
  write(bundle, original);
  write(saved, "copied but corrupted\n");
  retry(/evidence missing or corrupt: .*report.md/);
  write(saved, "verified report\n");
  write(report, "changed after verification\n");
  write(mode, "lost-result");
  const interrupted = retry();
  assert.ok(!existsSync(cwd), interrupted.out);
  const changed = f.show().working_copy.disposal;
  assert.equal(changed.phase, "unknown");
  assert.notEqual(changed.evidence.path, proof.path);
  assert.equal(readFileSync(saved, "utf8"), "verified report\n");
  assert.equal(readFileSync(join(changed.evidence.path, "files", relative(cwd, report)), "utf8"), "changed after verification\n");
  const reconciled = retry();
  assert.equal(f.show().working_copy.disposal.phase, "removed", reconciled.out);
});

test("managed worktree: explicit committed baseline, dirty source unchanged, same resource in CLI and board", async (t) => {
  const f = await managedFixture(t);
  const base = git(f.repo, "rev-parse", "HEAD");
  write(join(f.repo, "package.json"), '{"newer":true}\n');
  git(f.repo, "commit", "-qam", "newer source");
  write(join(f.repo, "package.json"), '{"dirty":true}\n');
  git(f.repo, "add", "package.json");
  write(join(f.repo, "untracked"), "source only\n");
  const before = git(f.repo, "status", "--porcelain");
  const started = f.start("--base", base);
  assert.ok(started.ok, started.out);
  const row = f.show();
  assert.equal(row.kind, "worktree");
  assert.equal(row.status, "open");
  assert.equal(row.working_copy.owner, f.id);
  assert.equal(row.working_copy.backend, "git-worktree");
  assert.equal(row.working_copy.baseline, base);
  assert.equal(row.working_copy.phase, "ready");
  assert.equal(row.working_copy.path, row.cwd);
  assert.ok(row.working_copy.identity);
  assert.deepEqual(f.board().working_copy, row.working_copy);
  assert.equal(f.board(f.legacy).working_copy, null);
  assert.equal(f.show(f.legacy).kind, "worktree");
  assert.equal(git(row.cwd, "rev-parse", "HEAD"), base);
  assert.equal(readFileSync(join(row.cwd, "package.json"), "utf8"), "{}\n");
  assert.ok(!existsSync(join(row.cwd, "untracked")));
  assert.equal(git(f.repo, "status", "--porcelain"), before);
  assert.equal(readFileSync(join(f.repo, "package.json"), "utf8"), '{"dirty":true}\n');
});

test("managed worktree: remote retry uses the planned baseline through SSH and Paseo", async (t) => {
  const f = await managedFixture(t, "off", true);
  const bin = join(f.root, "bin"), log = join(f.root, "ssh.log");
  write(join(bin, "ssh"), `#!/bin/sh
[ "$1" = -o ] && [ "$2" = BatchMode=yes ] && [ "$3" = fake-host ] || exit 1
printf '%s\\n' "$4" >> ${JSON.stringify(log)}
exec sh -c "$4"
`);
  chmodSync(join(bin, "ssh"), 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const configure = (url) => write(f.env.PP_CONFIG, JSON.stringify({
    profiles: { fake: { provider: "claude/fake-model" } }, machines: { remote: { url, ssh: "fake-host" } },
  }));
  const base = git(f.repo, "rev-parse", "HEAD");
  configure(NO_DAEMON);
  const start = f.start("--machine", "remote");
  assert.ok(!start.ok, start.out);
  const planned = f.board().working_copy;
  assert.equal(planned.phase, "planned");
  assert.equal(planned.baseline, base);
  assert.equal(planned.identity, null);
  assert.ok(!existsSync(planned.path));
  git(f.repo, "commit", "--allow-empty", "-qm", "source moved since planning");
  configure(f.env.PASEO_URL);
  const restart = f.pp("thread", "restart", "demo", f.id, "--fresh");
  assert.ok(restart.ok, restart.out);
  const after = f.show();
  assert.equal(after.kind, "worktree");
  assert.equal(after.status, "open");
  assert.equal(after.working_copy.machine, "remote");
  assert.equal(after.cwd, planned.path);
  assert.equal(after.working_copy.phase, "ready");
  assert.equal(git(after.cwd, "rev-parse", "HEAD"), base);
  assert.match(readFileSync(log, "utf8"), /worktree add/);
  assert.equal(after.workspace_id, "wks_ovnfs_0");
  assert.deepEqual(f.board().working_copy, after.working_copy);
});

async function sshDisposalFixture(t) {
  const f = await managedFixture(t, "off", true);
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const [o, batch, host, command] = process.argv.slice(2);
if (o !== '-o' || batch !== 'BatchMode=yes' || host !== 'fake-host') process.exit(1);
const target = process.env.FAKE_SSH_LOSE_REMOVAL;
const existed = target && existsSync(target);
const input = process.env.FAKE_SSH_DROP_REMOVAL ? readFileSync(0) : undefined;
if (input?.includes('"action":"remove"')) process.exit(255);
const script = process.env.FAKE_LSOF_DENIED_PATH ? command.replace('NODE_PATH= node -e', 'NODE_PATH= node --require "$FAKE_SSH_FS_PROBE" -e') : command;
const r = spawnSync('sh', ['-c', script], { input, stdio: [input ? 'pipe' : 'inherit', 'pipe', 'pipe'], maxBuffer: 48 * 1024 * 1024 });
if (existed && !existsSync(target)) process.exit(255);
let output = r.stdout || '';
if (process.env.FAKE_SSH_DAMAGE_BUNDLE && String(output).includes('"bundle":')) {
  const response = JSON.parse(output);
  response.bundle = Buffer.from('not a Git bundle').toString('base64');
  output = JSON.stringify(response);
}
process.stdout.write(output);
process.stderr.write(r.stderr || '');
process.exitCode = r.status ?? 1;
`, { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/sh
if [ -n "$FAKE_LSOF_NEW_FILE" ]; then
  if [ -f "$FAKE_LSOF_MARKER" ]; then
    mkdir -p "$(dirname "$FAKE_LSOF_NEW_FILE")" && printf 'new data\\n' > "$FAKE_LSOF_NEW_FILE" || exit 1
  else
    : > "$FAKE_LSOF_MARKER" || exit 1
  fi
fi
printf 'p1\\000\\nfcwd\\000n%s\\000\\n' "\${FAKE_LSOF_PATH:-/}"
`, { mode: 0o755 });
  writeFileSync(join(bin, "mount"), `#!/bin/sh
printf 'fixture on / (fixture)\\n'
if [ -n "$FAKE_MOUNT_PATH" ]; then
  printf 'fixture on %s (fixture)\\n' "$FAKE_MOUNT_PATH"
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "findmnt"), `#!/bin/sh
printf '/\\n'
if [ -n "$FAKE_MOUNT_PATH" ]; then
  printf '%s\\n' "$FAKE_MOUNT_PATH"
fi
`, { mode: 0o755 });
  f.env.FAKE_SSH_FS_PROBE = join(bin, "denied-path.cjs");
  writeFileSync(f.env.FAKE_SSH_FS_PROBE, `const fs = require('node:fs');
const lstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => {
  if (String(path) === process.env.FAKE_LSOF_DENIED_PATH) throw Object.assign(new Error('injected stat denial: ' + path), { code: 'EACCES' });
  return lstat(path, ...args);
};
`);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  write(f.env.PP_CONFIG, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } }, machines: { remote: { url: f.env.PASEO_URL, ssh: "fake-host" } } }));
  const started = f.start("--machine", "remote");
  assert.ok(started.ok, started.out);
  return f;
}

test("managed SSH disposal: independently restores preserved commits and binary data before verified removal", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd, branch, thread_dir: td, working_copy: w } = f.show();
  git(cwd, "switch", "--detach", "HEAD");
  git(cwd, "commit", "--allow-empty", "-qm", "detached result");
  const commit = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", branch);
  write(join(td, "cleanup.json"), JSON.stringify({ commits: [commit] }));
  const bytes = Buffer.from([0, 255, 128, 10, 12]);
  write(join(td, "library", "output.bin"), bytes);
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.ok(!existsSync(cwd), r.out);
  assert.ok(!existsSync(w.identity.git_dir), r.out);
  assert.ok(!git(f.repo, "worktree", "list", "--porcelain").includes(cwd), r.out);
  assert.equal(f.show().working_copy.phase, "removed");
  const evidence = f.show().working_copy.disposal.evidence.path;
  const restored = join(f.root, "restored.git");
  git(f.root, "clone", "--mirror", join(evidence, "commits.bundle"), restored);
  assert.equal(git(restored, "rev-parse", `refs/heads/saved/${commit}`), commit);
  assert.deepEqual(readFileSync(join(evidence, "files", relative(cwd, td), "library", "output.bin")), bytes);
  assert.equal(git(f.repo, "rev-parse", branch), w.baseline);
});

test("managed SSH disposal: retains a worktree occupied through a path alias until released", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd } = f.show();
  const alias = join(f.root, "checkout-alias");
  symlinkSync(cwd, alias);
  f.env.FAKE_LSOF_PATH = alias;
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH worktree occupied by process/);
  assert.ok(existsSync(cwd), r.out);
  assert.equal(f.show().working_copy.disposal.phase, "retained");
  delete f.env.FAKE_LSOF_PATH;
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.ok(!existsSync(cwd), retry.out);
  assert.equal(f.show().working_copy.disposal.phase, "removed");
});

test("managed SSH disposal: tolerates unreadable open paths outside the worktree but refuses an alias inside", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd } = f.show();
  const alias = join(f.root, "unreadable-alias");
  symlinkSync(cwd, alias);
  f.env.FAKE_LSOF_PATH = f.env.FAKE_LSOF_DENIED_PATH = join(alias, "unreadable");
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH worktree occupied by process/);
  assert.ok(existsSync(cwd), r.out);
  assert.equal(f.show().working_copy.disposal.phase, "retained");
  f.env.FAKE_LSOF_PATH = f.env.FAKE_LSOF_DENIED_PATH = join(f.root, "unreadable");
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.ok(!existsSync(cwd), retry.out);
  assert.equal(f.show().working_copy.disposal.phase, "removed");
});

test("managed SSH disposal: accepts escaped open paths outside the worktree but refuses an escaped alias inside", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd } = f.show();
  symlinkSync(cwd, join(f.root, "alias-é"));
  f.env.FAKE_LSOF_PATH = join(f.root, String.raw`alias-\xc3\xa9`, "unlinked file");
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH worktree occupied by process/);
  assert.ok(existsSync(cwd), r.out);
  assert.equal(f.show().working_copy.disposal.phase, "retained");
  f.env.FAKE_LSOF_PATH = join(f.root, String.raw`font-\xe3\x83\x92 W6.ttc`);
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.ok(!existsSync(cwd), retry.out);
  assert.equal(f.show().working_copy.disposal.phase, "removed");
});

test("managed SSH disposal: reconciles a lost removal reply and keeps a merged-review branch", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd, branch, working_copy: w } = f.show();
  f.env.FAKE_SSH_LOSE_REMOVAL = cwd;
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH cleanup connection or inspection failed/);
  assert.equal(f.show().working_copy.disposal.phase, "unknown");
  assert.ok(!existsSync(cwd));
  assert.ok(!existsSync(w.identity.git_dir));
  const record = f.p.path("threads", `${f.id}.json`);
  write(record, JSON.stringify({ ...JSON.parse(readFileSync(record)), resolved_reason: "reviewed PR merged" }));
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.equal(f.show().working_copy.disposal.phase, "removed");
  assert.match(retry.out, /SSH worktree removal verified/);
  assert.match(retry.out, /branch .* kept: SSH branch identity and reflog deletion are not verified/);
  assert.equal(git(f.repo, "rev-parse", `refs/heads/${branch}`), w.baseline);
});

test("managed SSH disposal: does not resend an uncertain removal when the checkout still exists", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd, working_copy: w } = f.show();
  f.env.FAKE_SSH_DROP_REMOVAL = "1";
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH cleanup connection or inspection failed/);
  assert.equal(f.show().working_copy.disposal.phase, "unknown");
  delete f.env.FAKE_SSH_DROP_REMOVAL;
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.match(retry.out, /will not send another SSH removal/);
  assert.ok(existsSync(cwd) && existsSync(w.identity.git_dir), retry.out);
  assert.equal(f.show().working_copy.disposal.phase, "unknown");
});

test("managed SSH disposal: retains a dependent, unclassified ignored data, or an unrestorable bundle", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd, working_copy: w } = f.show();
  const alias = join(f.root, "dependent-alias");
  symlinkSync(cwd, alias);
  const legacy = f.p.path("threads", `${f.legacy}.json`), old = readFileSync(legacy);
  write(legacy, JSON.stringify({ ...JSON.parse(old), machine: "remote", cwd: join(alias, "not-yet-created") }));
  const dependent = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.match(dependent.out, /SSH dependency uses this worktree/);
  write(legacy, old);
  const unknown = join(cwd, "node_modules", "local-progress");
  write(unknown, "not disposable\n");
  const retry = () => f.pp("thread", "cleanup", "demo", f.id);
  const ignored = retry();
  assert.match(ignored.out, /unclassified SSH file: node_modules\/local-progress/);
  assert.equal(readFileSync(unknown, "utf8"), "not disposable\n");
  rmSync(dirname(unknown), { recursive: true });
  f.env.FAKE_SSH_DAMAGE_BUNDLE = "1";
  const bad = retry();
  assert.match(bad.out, /could not independently restore commits/);
  assert.ok(existsSync(cwd) && existsSync(w.identity.git_dir), bad.out);
  assert.equal(f.show().working_copy.disposal.evidence, undefined);
  delete f.env.FAKE_SSH_DAMAGE_BUNDLE;
  const good = retry();
  assert.ok(good.ok, good.out);
  assert.equal(f.show().working_copy.disposal.phase, "removed");
});

test("managed SSH disposal: a new ignored file during the last probe blocks removal", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd } = f.show();
  const newFile = join(cwd, "node_modules", "new-progress");
  f.env.FAKE_LSOF_NEW_FILE = newFile;
  f.env.FAKE_LSOF_MARKER = join(f.root, "lsof-first-probe");
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.ok(existsSync(newFile), r.out);
  assert.equal(readFileSync(newFile, "utf8"), "new data\n");
  assert.match(r.out, /SSH checkout changed after inspection/);
  assert.equal(f.show().working_copy.disposal.phase, "retained");
});

for (const remote of [true, false]) {
  test(`managed ${remote ? "SSH" : "local"} disposal: native Git catches a late untracked file despite repository config`, async (t) => {
    const f = remote ? await sshDisposalFixture(t) : await managedFixture(t);
    if (!remote) assert.ok(f.start().ok);
    const { cwd, working_copy: w } = f.show();
    git(f.repo, "config", "status.showUntrackedFiles", "no");
    const bin = join(f.root, "git-shim");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
case " $* " in
  *" worktree remove "*) printf 'late data\\n' > "$FAKE_GIT_NEW_FILE" || exit 1 ;;
esac
exec env PATH="$FAKE_GIT_REAL_PATH" git "$@"
`, { mode: 0o755 });
    f.env.FAKE_GIT_NEW_FILE = join(cwd, "late-progress.txt");
    f.env.FAKE_GIT_REAL_PATH = f.env.PATH;
    f.env.PATH = `${bin}:${f.env.PATH}`;
    const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
    assert.ok(r.ok, r.out);
    assert.ok(existsSync(f.env.FAKE_GIT_NEW_FILE), r.out);
    assert.equal(readFileSync(f.env.FAKE_GIT_NEW_FILE, "utf8"), "late data\n");
    assert.ok(existsSync(w.identity.git_dir), r.out);
    assert.notEqual(f.show().working_copy.disposal.phase, "removed");
  });
}

test("managed SSH disposal: retains a path with a mounted filesystem", async (t) => {
  const f = await sshDisposalFixture(t);
  const { cwd } = f.show();
  f.env.FAKE_MOUNT_PATH = join(cwd, "tracked.txt");
  const r = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(r.ok, r.out);
  assert.match(r.out, /SSH worktree contains a mount: /);
  assert.ok(existsSync(cwd), r.out);
  assert.equal(f.show().working_copy.disposal.phase, "retained");
});

test("managed worktree: failure before Agent dispatch retains a restartable copy and its changes", async (t) => {
  const f = await managedFixture(t, "before-launch");
  const started = f.start();
  assert.ok(!started.ok, started.out);
  assert.match(started.out, /workspace lookup refused/);
  const row = f.show();
  assert.equal(row.status, "failed");
  assert.equal(row.working_copy.phase, "ready");
  assert.equal(f.board().error.includes("workspace lookup refused"), true);
  const worktrees = git(f.repo, "worktree", "list", "--porcelain");
  git(row.cwd, "commit", "--allow-empty", "-qm", "saved progress");
  write(join(row.cwd, "local-progress"), "keep me\n");
  git(row.cwd, "branch", "-m", "renamed-progress");
  const restart = f.pp("thread", "restart", "demo", f.id, "--fresh");
  assert.ok(restart.ok, restart.out);
  const after = f.show();
  assert.equal(after.status, "open");
  assert.equal(after.cwd, row.cwd);
  assert.equal(after.branch, "renamed-progress");
  assert.deepEqual(after.working_copy, row.working_copy);
  assert.equal(git(row.cwd, "log", "-1", "--format=%s"), "saved progress");
  assert.equal(readFileSync(join(row.cwd, "local-progress"), "utf8"), "keep me\n");
  assert.deepEqual(git(f.repo, "worktree", "list", "--porcelain").match(/^worktree .+$/gm), worktrees.match(/^worktree .+$/gm));
});

// One ticker pass in its own process, `gh` faked: the pull request is merged.
const FAKE_GH_DIR = join(BASE, "fake-gh");
write(join(FAKE_GH_DIR, "gh"), `#!/usr/bin/env node
const a = process.argv.slice(2);
const view = process.env.FAKE_GH_VIEW;
const matched = JSON.parse(view || "{}")[a.at(-1).toLowerCase()];
if (process.env.FAKE_GH_FAIL_HEAD && a.includes("--head=" + process.env.FAKE_GH_FAIL_HEAD)) process.exit(1);
console.log(a[0] === "pr" && a[1] === "view" ? (matched ? JSON.stringify(matched) : view)
  : a[0] === "api" ? "me" : a.includes("--author") ? process.env.FAKE_GH_OPEN_OWN || "[]"
  : a.includes("--head=" + process.env.FAKE_GH_HEAD) ? process.env.FAKE_GH_HEAD_PRS : "[]");
`);
chmodSync(join(FAKE_GH_DIR, "gh"), 0o755);
const ORCH = join(dirname(fileURLToPath(import.meta.url)), "..", "orchestrator");
const TICK = join(BASE, "tick.mjs");
writeFileSync(TICK, `const { tick } = await import(${JSON.stringify(pathToFileURL(join(ORCH, "ticker.mjs")).href)});
const { Project } = await import(${JSON.stringify(pathToFileURL(join(ORCH, "project.mjs")).href)});
if (process.argv[4]) Date.now = () => Date.parse(process.argv[4]);
await tick(new Project(process.argv[2], "demo"), process.argv[3]);
process.exit(0);
`);
const tickOnce = (f, started, view, clock = "") => new Promise((ok) => {
  const env = { ...f.env, PATH: `${FAKE_GH_DIR}:${f.env.PATH}`, FAKE_GH_VIEW: JSON.stringify(view) };
  const c = spawn(process.execPath, [TICK, f.root, started, clock], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => c.kill(), 120_000);
  c.on("exit", (code) => { clearTimeout(timer); ok({ code, out }); });
});

test("reconciliation discovers legacy and unregistered worktrees without claiming them, including on sweep and tick", async () => {
  const f = fixture();
  const recordPath = f.p.path("threads", `${f.id}.json`);
  write(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath)), status: "resolved" }));
  const record = readFileSync(recordPath, "utf8");
  const orphan = join(f.root, "unclaimed");
  git(f.repo, "worktree", "add", "-qb", "pp-demo-t-8000-orphan", orphan);
  const privateFile = join(f.wt, "unclassified.txt");
  write(privateFile, "keep the historical data\n");
  const before = git(f.repo, "worktree", "list", "--porcelain");

  const query = f.pp("thread", "discover", "demo");
  assert.ok(query.ok, query.out);
  const found = JSON.parse(query.out);
  const legacy = found.find((r) => r.path === f.wt);
  assert.equal(legacy.owner, f.id);
  assert.equal(legacy.phase, "pending-confirmation");
  const unknown = found.find((r) => r.path === orphan);
  assert.equal(unknown.owner, "");
  assert.equal(unknown.backend, "git-worktree");
  assert.equal(unknown.phase, "pending-confirmation");
  assert.match(unknown.blockers.join("; "), /not adopted/);
  const board = JSON.parse(f.pp("board", "resources").out);
  assert.ok(board.some((r) => r.project === "demo" && r.candidate === unknown.candidate));
  const detail = JSON.parse(f.pp("board", "thread", "demo", f.id).out);
  assert.deepEqual(detail.reconciliation, [legacy]);

  const result = f.pp("sweep", "demo", "--yes");
  assert.ok(result.ok, result.out);
  assert.equal((await tickOnce(f, new Date().toISOString(), {})).code, 0);
  assert.equal(git(f.repo, "worktree", "list", "--porcelain"), before);
  assert.equal(readFileSync(recordPath, "utf8"), record);
  assert.equal(readFileSync(privateFile, "utf8"), "keep the historical data\n");
});

test("reconciliation legacy cleanup does not remove a replacement with the same path and branch", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const moved = join(f.root, "historical");
  git(f.wt, "switch", "-qc", "moved-aside");
  git(f.repo, "worktree", "move", f.wt, moved);
  git(f.repo, "worktree", "add", "-q", f.wt, f.branch);
  const result = f.pp("thread", "resolve", "demo", f.id, "--skip-copy");
  assert.ok(result.ok, result.out);
  assert.ok(existsSync(f.wt), result.out);
  assert.ok(existsSync(join(moved, ".paseo-project", `demo-${f.id}`, "report.md")));
});

test("reconciliation legacy cleanup keeps commits reachable only from the linked worktree HEAD reflog", async (t) => {
  const daemon = await fakeDaemon("off");
  const f = fixture();
  f.env.PASEO_URL = daemon.url;
  t.after(() => { daemon.stop(); rmSync(f.root, { recursive: true, force: true }); });
  git(f.wt, "switch", "--detach", "HEAD");
  git(f.wt, "commit", "-q", "--allow-empty", "-m", "detached work to keep");
  const detached = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "switch", f.branch);
  assert.equal(git(f.repo, "for-each-ref", "--contains", detached), "");
  assert.ok(git(f.repo, "rev-list", "--all", "--reflog").includes(detached));

  writeSettings(f.p, { ...f.p.settings(), mute: true, nudge: false });
  write(join(f.td, "report.md"), `Reviewed-PR: ${REVIEW_URL}\n\n## Report\nDone\n`);
  const progress = f.pp("report", "--thread", `demo/${f.id}`, "--percent", "100");
  assert.ok(progress.ok, progress.out);
  const resolved = await tickOnce(f, new Date().toISOString(), { [REVIEW_URL]: { state: "MERGED" } });
  assert.equal(resolved.code, 0, resolved.out);
  assert.equal(JSON.parse(readFileSync(f.p.path("threads", `${f.id}.json`))).resolved_reason, "reviewed PR merged");
  assert.ok(f.pp("sweep", "demo", "--yes").ok);
  assert.ok(existsSync(f.wt));

  const file = f.p.path("threads", `${f.id}.cleanup.json`);
  const previous = existsSync(file) ? readFileSync(file, "utf8") : null;
  const dryRun = f.pp("thread", "cleanup", "demo", f.id, "--dry-run");
  assert.ok(dryRun.ok, dryRun.out);
  assert.equal(existsSync(file) ? readFileSync(file, "utf8") : null, previous);
  assert.doesNotMatch(dryRun.out, /worktree would be removed/);
  const cleanup = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(cleanup.ok, cleanup.out);
  assert.ok(existsSync(f.wt));
  assert.ok(git(f.repo, "rev-list", "--all", "--reflog").includes(detached));
  const record = f.cleanup(), item = f.item("worktree");
  assert.equal(record.state, "blocked");
  assert.equal(item.status, "blocked");
  assert.equal(record.archive, "complete");
  assert.equal(record.archive_scope, "report-and-library");
  assert.equal(record.git_history_archive, "unknown");
  assert.equal(record.removed_kib, 0);
  const markdown = readFileSync(f.p.path("threads", `${f.id}.cleanup.md`), "utf8");
  assert.match(markdown, /report\/library archive \*\*complete\*\*; Git history archive \*\*unknown\*\*/);
  assert.match(item.reason, /worktree HEAD reflog/);
  assert.ok(dryRun.out.includes(`worktree blocked: ${item.reason}`), dryRun.out);
  assert.ok(cleanup.out.includes(`worktree blocked: ${item.reason}`), cleanup.out);
  const detail = JSON.parse(f.pp("board", "thread", "demo", f.id).out).reconciliation.find((row) => row.path === f.wt);
  const board = JSON.parse(f.pp("board", "resources").out).find((row) => row.owner === f.id && row.path === f.wt);
  assert.equal(detail.phase, "pending-confirmation");
  assert.equal(detail.disposal.phase, "blocked");
  assert.ok(detail.blockers.includes(item.reason));
  assert.deepEqual(board, detail);
  const show = f.pp("thread", "show", "demo", f.id).out;
  assert.match(show, /disposal: blocked/);
  assert.ok(show.includes(item.reason));

  for (let run = 0; run < 2; run++) {
    const tick = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(tick.code, 0, tick.out);
  }
  assert.deepEqual(f.cleanup(), record, "the ticker must not retry unadopted cleanup");
  const inbox = f.pp("inbox", "list", "demo").out.split("\n");
  assert.equal(inbox.filter((line) => line.includes(`legacy Git cleanup blocked: ${item.reason}`)).length, 1);
  assert.ok(f.pp("thread", "cleanup", "demo", f.id, "--dry-run").out.includes(item.reason));
  assert.deepEqual(f.cleanup(), record, "preview must not replace an existing blocker record");

  git(f.repo, "branch", "preserved-detached-work", detached);
  const retry = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(retry.ok, retry.out);
  assert.equal(f.cleanup().state, "complete");
  assert.equal(f.item("worktree").status, "removed");
  assert.equal(git(f.repo, "rev-parse", "preserved-detached-work"), detached);
  const retried = JSON.parse(f.pp("board", "thread", "demo", f.id).out).reconciliation.find((row) => row.path === f.wt);
  assert.ok(!retried?.disposal);
});

test("reconciliation cleanup retains a same-tip replacement branch and its reflog-only commit", (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const file = f.p.path("threads", `${f.id}.json`);
  const record = JSON.parse(readFileSync(file));
  const base = record.branch_start.oid;
  write(file, JSON.stringify({ ...record, status: "resolved", resolved_reason: "reviewed PR merged" }));
  git(f.repo, "worktree", "remove", "--force", f.wt);
  git(f.repo, "branch", "-D", f.branch);
  git(f.repo, "switch", "-qc", f.branch, base);
  git(f.repo, "commit", "-q", "--allow-empty", "-m", "reflog-only replacement commit");
  const privateTip = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "reset", "-q", "--hard", base);
  git(f.repo, "switch", "-q", "main");
  assert.equal(git(f.repo, "for-each-ref", "--contains", privateTip), "");
  const reflog = git(f.repo, "reflog", "show", "--format=%H", f.branch);
  assert.ok(reflog.includes(privateTip));

  const result = f.pp("thread", "cleanup", "demo", f.id);
  assert.ok(result.ok, result.out);
  assert.match(result.out, /branch .* kept: .*branch identity/);
  assert.equal(git(f.repo, "rev-parse", `refs/heads/${f.branch}`), base);
  assert.equal(git(f.repo, "reflog", "show", "--format=%H", f.branch), reflog);
  const detail = JSON.parse(f.pp("board", "thread", "demo", f.id).out);
  assert.match(detail.reconciliation[0].blockers.join("; "), /branch identity/);
});

test("reconciliation lists the retained branch after an adopted worktree is reclaimed", async (t) => {
  const f = fixture();
  const daemon = await fakeDaemon("off", "", f.wt);
  const record = f.p.path("threads", `${f.id}.json`);
  write(record, JSON.stringify({ ...JSON.parse(readFileSync(record)), agent_id: "agent-for-resolve" }));
  f.env.PASEO_URL = daemon.url;
  t.after(() => { daemon.stop(); rmSync(f.root, { recursive: true, force: true }); });
  const discovery = f.pp("thread", "discover", "demo");
  assert.ok(discovery.ok, discovery.out);
  const { candidate, baseline } = JSON.parse(discovery.out).find((row) => row.owner === f.id);
  ppAtTerminal(f, "thread", "adopt", "demo", f.id, "--candidate", candidate, "--base", baseline);
  const reflog = git(f.repo, "reflog", "show", "--format=%H", f.branch);
  assert.ok(reflog);
  writeSettings(f.p, { ...f.p.settings(), mute: true, nudge: false });
  write(join(f.td, "report.md"), `Reviewed-PR: ${REVIEW_URL}\n\n## Report\nDone\n`);
  assert.ok(f.pp("report", "--thread", `demo/${f.id}`, "--percent", "100").ok);
  const resolved = await tickOnce(f, new Date().toISOString(), { [REVIEW_URL]: { state: "MERGED" } });
  assert.equal(resolved.code, 0, resolved.out);
  const sweep = f.pp("sweep", "demo", "--yes");
  assert.ok(sweep.ok, sweep.out);
  assert.ok(!existsSync(f.wt), sweep.out);
  assert.equal(git(f.repo, "reflog", "show", "--format=%H", f.branch), reflog);

  const detail = JSON.parse(f.pp("board", "thread", "demo", f.id).out).working_copy;
  const blocker = detail.blockers.find((reason) => reason.includes("branch identity"));
  assert.ok(blocker);
  const cli = f.pp("thread", "show", "demo", f.id);
  assert.ok(cli.out.includes(blocker), cli.out);
  const board = f.pp("board", "resources");
  assert.ok(board.ok, board.out);
  const retained = JSON.parse(board.out).find((row) => row.owner === f.id && row.branch === f.branch);
  assert.equal(retained?.phase, "retained", board.out);
  assert.ok(retained.blockers.includes(blocker));
});

test("reconciliation refuses an adoption origin rewritten by git reflog delete", async (t) => {
  const f = await managedFixture(t);
  const started = f.start();
  assert.ok(started.ok, started.out);
  const path = join(f.root, "rewritten-origin");
  git(f.repo, "worktree", "add", "-qb", "rewritten-origin", path);
  const initial = git(path, "rev-parse", "HEAD");
  const find = () => {
    const result = f.pp("thread", "discover", "demo");
    assert.ok(result.ok, result.out);
    return JSON.parse(result.out).find((row) => row.path === path);
  };
  assert.equal(find().baseline, initial);
  const gitDir = git(path, "rev-parse", "--absolute-git-dir");
  const born = Math.floor(statSync(gitDir).birthtimeMs / 1000);
  execFileSync("git", [...G, "-C", path, "commit", "-q", "--allow-empty", "-m", "later commit"], {
    env: { ...process.env, GIT_COMMITTER_DATE: `@${born} +0000` }, stdio: ["ignore", "pipe", "pipe"],
  });
  const later = git(path, "rev-parse", "HEAD");
  git(f.repo, "merge", "-q", "--ff-only", later); // satisfy source reachability; it is not origin evidence
  const token = find().candidate;
  assert.match(token, /^[a-f0-9]{64}$/);
  // Remove the two native creation entries. Git now writes a zero predecessor for the later commit.
  git(path, "reflog", "delete", "--rewrite", "HEAD@{2}", "HEAD@{1}");
  const log = readFileSync(join(gitDir, "logs", "HEAD"), "utf8");
  assert.ok(log.startsWith(`${"0".repeat(initial.length)} ${later} `), log);
  const row = find();
  const adopted = terminalResult(f, "thread", "adopt", "demo", f.id, "--candidate", row.candidate || token, "--base", later);
  assert.notEqual(adopted.status, 0, adopted.out);
  assert.match(adopted.out, /no longer verified.*preserve the work independently and leave this Git resource unmanaged/);
  assert.equal(row.candidate, "");
  assert.ok(!row.baseline);
  assert.match(row.blockers.join("; "), /original checkout commit cannot be verified/);
  assert.ok(row.actions.includes("preserve the work independently and leave this Git resource unmanaged"));
  assert.deepEqual(f.board().working_copies, []);
});

test("reconciliation discovers the pinned OVNFS registry without adopting or mutating it", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await managedOvnfsFixture(t, "discover", "off");
  const checkout = join(f.mount, "outside-pp");
  const offProject = join(f.mount, "different-project");
  const fixture = JSON.stringify({
    checkouts: [{ name: "outside-pp", path: checkout, source: f.repo, base: "seed", created: new Date().toISOString() },
      { name: "different-project", path: offProject, source: "/not/a/project/repo" }],
    snapshots: [{ checkout: "outside-pp", id: "s1", label: "do-not-surface-label" }, { checkout: "departed", id: "s2" }],
  });
  const file = join(f.state, "discovery");
  write(file, fixture);
  const reply = f.pp("thread", "discover", "demo");
  assert.ok(reply.ok, reply.out);
  const rows = JSON.parse(reply.out);
  const w = rows.find((r) => r.path === checkout);
  assert.equal(w?.backend, "ovnfs");
  assert.equal(w.phase, "pending-confirmation");
  assert.equal(w.candidate, "");
  assert.match(w.blockers.join(" "), /identity.*origin/);
  assert.ok(rows.some((r) => r.resource === "s1" && r.phase === "pending-confirmation"));
  assert.ok(rows.some((r) => r.backend === "ovnfs" && r.blockers.some((b) => /source cannot be verified/.test(b))));
  assert.ok(!reply.out.includes(offProject) && !reply.out.includes("do-not-surface-label"));
  assert.equal(readFileSync(file, "utf8"), fixture);
  assert.deepEqual([...new Set(f.calls().flatMap((m) => Object.keys(m).filter((k) => k !== "id")))].sort(), ["ls", "status"]);
});

test("reconciliation adopts only the authorized Git identity and verified origin, preserving historical data and keeps", async () => {
  const daemon = await fakeDaemon("off");
  try {
    const f = fixture();
    f.env.PASEO_URL = daemon.url;
    const recordPath = f.p.path("threads", `${f.id}.json`);
    const orig = { ...JSON.parse(readFileSync(recordPath)), status: "resolved", kept_worktree: true };
    write(recordPath, JSON.stringify(orig));
    const baseline = git(f.repo, "rev-parse", "HEAD");
    const privateFile = join(f.wt, "historical.txt");
    write(privateFile, "unique history\n");
    git(f.wt, "add", "historical.txt");
    git(f.wt, "commit", "-qm", "private");
    const privateTip = git(f.wt, "rev-parse", "HEAD");
    const candidate = () => JSON.parse(f.pp("thread", "discover", "demo").out).find((r) => r.owner === f.id).candidate;
    const token = candidate();
    assert.match(token, /^[a-f0-9]{64}$/);
    const args = (base, proof = token) => ["thread", "adopt", "demo", f.id, "--candidate", proof, "--base", base];
    assert.match(f.pp(...args(baseline)).out, /must be run by a person/);
    const badBase = terminalResult(f, ...args(privateTip));
    assert.notEqual(badBase.status, 0);
    assert.match(badBase.out, /original checkout commit/);
    assert.deepEqual(JSON.parse(readFileSync(recordPath)), orig);
    assert.equal(readFileSync(privateFile, "utf8"), "unique history\n");

    const otherPath = join(f.root, "displaced");
    git(f.repo, "worktree", "move", f.wt, otherPath);
    git(f.repo, "worktree", "add", "-qb", "replacement", f.wt, baseline);
    const stale = terminalResult(f, ...args(baseline));
    assert.notEqual(stale.status, 0);
    assert.match(stale.out, /no longer verified/);
    assert.equal(readFileSync(join(otherPath, "historical.txt"), "utf8"), "unique history\n");
    git(f.repo, "worktree", "remove", f.wt);
    git(f.repo, "worktree", "move", otherPath, f.wt);
    const gitDir = git(f.wt, "rev-parse", "--absolute-git-dir");
    const before = git(f.repo, "worktree", "list", "--porcelain");
    ppAtTerminal(f, ...args(baseline, candidate()));
    const detail = JSON.parse(f.pp("board", "thread", "demo", f.id).out);
    assert.deepEqual(detail.reconciliation, []);
    const w = detail.working_copy;
    assert.equal(w.owner, f.id);
    assert.equal(w.backend, "git-worktree");
    assert.equal(w.baseline, baseline);
    assert.deepEqual(w.adoption.origin, { kind: "git-worktree-initial-commit", source: f.repo, commit: baseline });
    assert.ok(w.blockers.some((b) => b.includes("keep-worktree")));
    assert.equal(git(f.repo, "worktree", "list", "--porcelain"), before);
    assert.ok(!existsSync(join(gitDir, "pp-working-copy")));
    const ticked = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(ticked.code, 0, ticked.out);
    const threaded = JSON.parse(readFileSync(recordPath));
    assert.equal(threaded.kind, orig.kind);
    assert.equal(threaded.kept_worktree, true);
    assert.equal(git(f.wt, "rev-parse", "HEAD"), privateTip);
    assert.equal(readFileSync(privateFile, "utf8"), "unique history\n");
  } finally { daemon.stop(); }
});

test("reconciliation registers an unclaimed Git resource once, even after a move", async (t) => {
  const f = await managedFixture(t);
  const started = f.start();
  assert.ok(started.ok, started.out);
  const path = join(f.root, "unregistered");
  git(f.repo, "worktree", "add", "-qb", "external", path);
  const discoveries = () => JSON.parse(f.pp("thread", "discover", "demo").out);
  const row = discoveries().find((r) => r.path === path);
  assert.equal(row.owner, "");
  const args = ["--candidate", row.candidate, "--base", row.baseline];
  const wrong = terminalResult(f, "thread", "adopt", "demo", f.legacy, ...args);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /cannot be assigned/);
  const before = f.board().working_copy;
  ppAtTerminal(f, "thread", "adopt", "demo", f.id, ...args);
  const registered = f.board();
  assert.deepEqual(registered.working_copy, before);
  assert.equal(registered.working_copies[0].path, path);
  assert.equal(registered.working_copies[0].owner, f.id);
  assert.ok(!discoveries().some((r) => r.path === path));

  const moved = join(f.root, "unregistered-moved");
  git(f.repo, "worktree", "move", path, moved);
  const shifted = discoveries().find((r) => r.path === moved);
  assert.equal(shifted?.candidate, "");
  assert.match(shifted.blockers.join(" "), /already associated/);
  assert.equal(f.board().working_copies.length, 1);
});

test("managed holds: terminal-authorized indefinite hold and release; unknown legacy hold stays closed", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const args = (sub, ...flags) => ["thread", sub, "demo", f.id, ...flags];
  ppAtTerminal(f, ...args("hold", "--reason", "keep for audit", "--indefinite"));
  assert.ok(f.pp(...args("resolve")).ok);
  const tick = async () => assert.equal((await tickOnce(f, new Date().toISOString(), {})).code, 0);
  await tick();
  const { cwd, working_copy: { blockers, nonce } } = f.board();
  assert.ok(blockers.includes("indefinite hold: keep for audit"));
  assert.ok(existsSync(cwd));
  ppAtTerminal(f, ...args("release", "--resource", nonce));
  assert.ok(!f.board().working_copy.blockers.some((b) => b.includes("hold")));
  const file = f.p.path("threads", `${f.id}.json`);
  const old = JSON.parse(readFileSync(file, "utf8"));
  old.kept_worktree = null;
  write(file, JSON.stringify(old));
  await tick();
  assert.ok(f.board().working_copy.blockers.includes("legacy hold is unknown; only a person can release it"));
  assert.ok(existsSync(cwd));
  assert.ok(f.pp(...args("resolve", "--reopen")).ok);
  assert.ok(f.pp(...args("resolve")).ok);
  assert.ok(f.board().working_copy.blockers.includes("legacy hold is unknown; only a person can release it"));
  assert.ok(existsSync(cwd));
  ppAtTerminal(f, ...args("release"));
  await tick();
  assert.equal(f.board().working_copy.phase, "removed");
  assert.ok(!existsSync(cwd));
});

test("managed holds: an expired deadline does not authorize removal of unknown files", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd } = f.board();
  const thread = JSON.parse(f.pp("thread", "show", "demo", f.id, "--json").out);
  const library = f.p.path("library", f.id, "notes.txt");
  write(join(thread.thread_dir, "library", "notes.txt"), "original notes\n");
  const until = new Date(Date.now() + 60_000).toISOString();
  const future = new Date(Date.parse(until) + 1).toISOString();
  const pp = (sub, ...flags) => f.pp("thread", sub, "demo", f.id, ...flags);
  assert.ok(pp("hold", "--reason", "investigating", "--until", until).ok);
  assert.ok(pp("resolve").ok);
  assert.match(f.board().working_copy.disposal.blocker, /hold: investigating/);
  write(library, "notes edited at home after resolve\n");
  const mystery = join(cwd, "new-data");
  write(mystery, "not cleared for removal\n");
  const tick = async () => assert.equal((await tickOnce(f, future, {}, future)).code, 0);
  await tick();
  assert.match(f.board().working_copy.disposal.blocker, /new-data/);
  assert.equal(readFileSync(mystery, "utf8"), "not cleared for removal\n");
  assert.equal(readFileSync(library, "utf8"), "notes edited at home after resolve\n");
  rmSync(mystery);
  await tick();
  assert.equal(f.board().working_copy.phase, "removed");
  assert.ok(!existsSync(cwd));
  assert.equal(readFileSync(library, "utf8"), "notes edited at home after resolve\n");
});

test("managed cleanup visibility: concurrent blockers and durable, deduplicated exceptions", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd, working_copy: { nonce } } = f.board();
  const bin = join(f.root, "bin"), probe = join(bin, "lsof");
  write(probe, "#!/bin/sh\nexit 2\n");
  chmodSync(probe, 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const pp = (sub, ...args) => f.pp("thread", sub, "demo", f.id, ...args);
  assert.ok(pp("hold", "--reason", "diagnosing", "--until", "2099-01-01T00:00:00Z").ok);
  assert.ok(pp("resolve").ok);
  assert.equal(f.board().status, "resolved");
  const { blockers, actions } = f.board().working_copy;
  assert.deepEqual(blockers, ["hold: diagnosing (until 2099-01-01T00:00:00.000Z)", "occupancy probe failed"]);
  assert.ok(actions.some((a) => a.includes(`thread release demo ${f.id} --resource ${nonce}`)));
  assert.deepEqual(f.show().working_copy.blockers, blockers);
  assert.match(pp("show").out, /occupancy probe failed/);
  const exceptions = () => f.pp("inbox", "list", "demo").out.split("\n").filter((line) => line.includes("[cleanup]"));
  const tick = async () => assert.equal((await tickOnce(f, new Date().toISOString(), {})).code, 0);
  await tick();
  const [original] = exceptions();
  assert.match(original, /occupancy probe failed/);
  assert.equal(exceptions().length, 1);
  assert.ok(f.pp("inbox", "done", "demo", original.split("\t")[0]).ok);
  await tick();
  assert.equal(exceptions().length, 0);
  write(probe, `#!/bin/sh\nprintf 'p12345\\000\\nfcwd\\000n%s\\000\\n' '${cwd}'\n`);
  await tick();
  assert.match(exceptions()[0], /occupied by process 12345/);
  write(probe, `#!/bin/sh\nprintf 'p12346\\000\\nfcwd\\000n%s\\000\\n' '${cwd}'\n`);
  await tick();
  assert.equal(exceptions().length, 1);
  assert.match(f.board().working_copy.blockers.join(" "), /occupied by process 12346/);
  assert.ok(existsSync(cwd));
});

test("managed retries: CLI and ticker cannot overlap removal, even if the initiating CLI dies", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const { cwd } = f.board();
  const bin = join(f.root, "bin"), seen = join(f.root, "removing"), go = join(f.root, "go"), finished = join(f.root, "finished");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  write(join(bin, "git"), `#!/usr/bin/env node
const fs = require('node:fs'), { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const removing = args.includes('worktree') && args.includes('remove');
if (removing) {
  fs.appendFileSync(${JSON.stringify(seen)}, 'remove\\n');
  const until = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  if (!fs.existsSync(${JSON.stringify(go)})) process.exit(42);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (removing) {
  fs.writeFileSync(${JSON.stringify(`${finished}.tmp`)}, String(r.status));
  fs.renameSync(${JSON.stringify(`${finished}.tmp`)}, ${JSON.stringify(finished)});
}
process.exit(r.status ?? 1);
`);
  write(join(bin, "lsof"), "#!/bin/sh\nprintf 'p12345\\000\\nfcwd\\000n/\\000\\n'\n");
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "lsof"), 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const argv = [PP, "--root", f.root, "thread"];
  const first = spawn(process.execPath, [...argv, "resolve", "demo", f.id], { env: f.env, stdio: "ignore" });
  const exited = new Promise((ok) => first.once("exit", ok));
  const waitFor = async (path) => {
    const until = Date.now() + 15_000;
    while (!existsSync(path) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 20));
    assert.ok(existsSync(path), `did not get ${path}`);
  };
  try {
    await waitFor(seen);
    assert.equal(f.board().working_copy.disposal.phase, "removing");
    const second = f.pp("thread", "cleanup", "demo", f.id);
    assert.match(second.out, /working-copy lifecycle is busy/);
    first.kill("SIGKILL");
    await exited;
    const tick = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(tick.code, 0, tick.out);
    assert.equal(readFileSync(seen, "utf8"), "remove\n");
    assert.ok(existsSync(cwd));
    assert.equal(f.board().working_copy.disposal.phase, "removing");
    write(go, "continue\n");
    await waitFor(finished);
    assert.equal(readFileSync(finished, "utf8"), "0");
    let phase;
    const until = Date.now() + 10_000;
    do {
      const recovered = await tickOnce(f, new Date().toISOString(), {});
      assert.equal(recovered.code, 0, recovered.out);
      phase = f.board().working_copy.disposal.phase;
    } while (phase === "removing" && Date.now() < until);
    assert.equal(phase, "removed");
    assert.equal(readFileSync(seen, "utf8"), "remove\n");
    assert.ok(!existsSync(cwd));
  } finally {
    write(go, "continue\n");
    first.kill("SIGKILL");
    await exited;
    if (existsSync(seen)) await waitFor(finished);
  }
});

test("managed retries: fresh tickers recheck a condition, occupancy, and evidence after a thread resolves", async (t) => {
  const f = await managedFixture(t);
  assert.ok(f.start().ok);
  const other = `t-${Number(f.id.slice(2)) + 1}`;
  assert.ok(f.start().ok);
  const pp = (id, sub, ...args) => f.pp("thread", sub, "demo", id, ...args);
  assert.match(pp(f.id, "hold", "--reason", "waiting", "--until-resolved", f.id).out, /another unresolved thread/);
  assert.ok(pp(f.id, "hold", "--reason", "waiting", "--until-resolved", other).ok);
  const { cwd } = f.board();
  const probe = join(f.root, "bin", "lsof");
  const probeWith = (path) => write(probe, `#!/bin/sh\nprintf 'p12345\\000\\nfcwd\\000n%s\\000\\n' '${path}'\n`);
  probeWith(cwd);
  chmodSync(probe, 0o755);
  f.env.PATH = `${dirname(probe)}:${f.env.PATH}`;
  assert.ok(pp(f.id, "resolve").ok);
  const tick = async () => {
    const r = await tickOnce(f, new Date().toISOString(), {});
    assert.equal(r.code, 0, r.out);
    return f.board();
  };
  assert.match((await tick()).working_copy.disposal.blocker, /hold: waiting/);
  assert.ok(pp(other, "resolve").ok);
  assert.match((await tick()).working_copy.disposal.blocker, /occupied by process 12345/);
  assert.ok(existsSync(cwd));
  write(join(cwd, "unique-data"), "not yet preserved\n");
  probeWith(f.root);
  assert.match((await tick()).working_copy.disposal.blocker, /unique-data/);
  assert.ok(existsSync(cwd));
  rmSync(join(cwd, "unique-data"));
  const removed = await tick();
  assert.equal(removed.status, "resolved");
  assert.equal(removed.working_copy.disposal.phase, "removed");
  assert.ok(!existsSync(cwd));
});

test("managed disposal: ticker finishes the thread and removes only unoccupied, dependency-free copies", async (t) => {
  const f = await managedFixture(t);
  for (let i = 0; i < 3; i++) assert.ok(f.start().ok);
  const idAt = (offset) => `t-${Number(f.id.slice(2)) + offset}`;
  const record = (id) => f.p.path("threads", `${id}.json`);
  const extras = [idAt(1), idAt(2)].map((id) => {
    const r = JSON.parse(readFileSync(record(id), "utf8"));
    rmSync(record(id));
    return { ...r.working_copy, thread_dir: r.thread_dir, owner: f.id };
  });
  const main = JSON.parse(readFileSync(record(f.id), "utf8"));
  main.working_copies = extras;
  const reviewed = "https://github.com/o/r/pull/9";
  write(join(main.thread_dir, "report.md"), `Reviewed-PR: ${reviewed}\n\n## Report\nDone\n`);
  write(record(f.id), JSON.stringify(main));
  const progress = f.pp("report", "--thread", `demo/${f.id}`, "--percent", "100");
  assert.ok(progress.ok, progress.out);
  const bin = join(f.root, "bin"), probe = join(bin, "lsof");
  write(probe, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`p12345\0\nfcwd\0n${extras[0].path}\0\n`)});\n`);
  chmodSync(probe, 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const tick = await tickOnce(f, new Date().toISOString(), { [reviewed]: { state: "MERGED" } });
  assert.equal(tick.code, 0, tick.out);
  const initial = f.board();
  assert.equal(initial.status, "resolved", tick.out);
  assert.equal(initial.working_copy.disposal.phase, "removed");
  assert.ok(!existsSync(main.cwd));
  assert.match(initial.working_copies[0].disposal.blocker, /occupied by process 12345/);
  assert.ok(existsSync(extras[0].path));
  assert.equal(initial.working_copies[1].disposal.phase, "removed");
  assert.ok(!existsSync(extras[1].path));

  const cleanup = () => {
    const r = f.pp("thread", "cleanup", "demo", f.id);
    assert.ok(r.ok, r.out);
    return f.board().working_copies[0].disposal;
  };
  write(probe, "#!/bin/sh\nprintf 'invalid data\\000\\n'\n");
  assert.match(cleanup().blocker, /occupancy probe returned malformed output/);
  write(probe, "#!/bin/sh\nexit 1\n");
  assert.match(cleanup().blocker, /occupancy probe failed/);
  const brokenRecord = record(idAt(2));
  write(brokenRecord, "not-json");
  rmSync(probe);
  assert.match(cleanup().blocker, /dependency inspection failed/);
  const ref = JSON.parse(readFileSync(record(f.id), "utf8"));
  ref.working_copies.push({ ...extras[1], nonce: "dependent-snapshot", backend: "snapshot", phase: "ready", disposal: undefined, depends_on: [extras[0].nonce] });
  rmSync(brokenRecord);
  write(record(f.id), JSON.stringify(ref));
  assert.match(cleanup().blocker, /depends on this worktree/);
  assert.ok(existsSync(extras[0].path));
  ref.working_copies.pop();
  write(record(f.id), JSON.stringify(ref));
  assert.equal(cleanup().phase, "removed");
  assert.ok(!existsSync(extras[0].path));
});

test("managed worktree: ticker reconciles an interrupted Git creation without launching an agent", async (t) => {
  const f = await managedFixture(t);
  const bin = join(f.root, "bin"), seen = join(f.root, "creation-intent.json");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const base = git(f.repo, "rev-parse", "HEAD");
  write(join(bin, "git"), `#!/usr/bin/env node
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs'), args = process.argv.slice(2);
if (args.includes('worktree') && args.includes('add')) {
  const intent = execFileSync(process.execPath, ${JSON.stringify([PP, "--root", f.root, "board", "thread", "demo", f.id])});
  fs.writeFileSync(${JSON.stringify(seen)}, intent);
}
const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
// Simulate loss of the creation result and inability to query Git in the same attempt.
process.exit(r.status || (fs.existsSync(${JSON.stringify(seen)}) ? 42 : 0));
`);
  chmodSync(join(bin, "git"), 0o755);
  const path = f.env.PATH;
  f.env.PATH = `${bin}:${path}`;
  const started = f.start();
  f.env.PATH = path;
  assert.ok(!started.ok, started.out);
  const intent = JSON.parse(readFileSync(seen, "utf8")).working_copy;
  assert.equal(intent.owner, f.id);
  assert.equal(intent.baseline, base);
  assert.equal(intent.identity, null);
  assert.equal(intent.phase, "creating");
  assert.equal(git(intent.path, "rev-parse", "HEAD"), base);
  assert.equal(f.board().working_copy.phase, "creating");
  const worktrees = git(f.repo, "worktree", "list", "--porcelain").match(/^worktree .+$/gm);
  const tick = await tickOnce(f, new Date().toISOString(), {});
  assert.equal(tick.code, 0, tick.out);
  const recovered = f.show();
  assert.equal(recovered.working_copy.phase, "ready");
  assert.equal(recovered.cwd, intent.path);
  assert.equal(recovered.agent_id, "");
  const restart = f.pp("thread", "restart", "demo", f.id, "--fresh");
  assert.ok(restart.ok, restart.out);
  assert.deepEqual(f.show().working_copy, recovered.working_copy);
  assert.deepEqual(git(f.repo, "worktree", "list", "--porcelain").match(/^worktree .+$/gm), worktrees);
});

test("managed worktree: missing or substituted checkout blocks execution and cleanup", async (t) => {
  const f = await managedFixture(t, "error-first");
  const started = f.start();
  assert.ok(started.ok, started.out);
  const row = f.show();
  const saved = join(f.root, "saved-worktree");
  git(row.cwd, "checkout", "--detach");
  git(f.repo, "worktree", "move", row.cwd, saved);
  const restart = () => f.pp("thread", "restart", "demo", f.id, "--fresh");
  const missing = restart();
  assert.ok(!missing.ok, missing.out);
  assert.match(missing.out, /worktree identity could not be verified/);
  assert.ok(!existsSync(row.cwd));
  git(f.repo, "worktree", "add", "-q", row.cwd, row.branch);
  write(join(row.thread_dir, "report.md"), "replacement report\n");
  const tick = await tickOnce(f, new Date().toISOString(), {});
  assert.equal(tick.code, 0, tick.out);
  const board = f.board();
  assert.equal(board.report, "(no report yet)");
  assert.match(board.working_copy.blocker, /identity does not match/);
  assert.deepEqual(board.working_copy.identity, row.working_copy.identity);
  const refused = restart();
  assert.ok(!refused.ok, refused.out);
  const prompted = f.pp("thread", "prompt", "demo", f.id, "--text", "do not send");
  assert.ok(!prompted.ok, prompted.out);
  assert.match(prompted.out, /identity does not match/);
  const resolved = f.pp("thread", "resolve", "demo", f.id, "--skip-copy", "--force");
  assert.ok(!resolved.ok, resolved.out);
  assert.match(resolved.out, /identity does not match/);
  assert.equal(f.show().agent_id, row.agent_id);
  assert.ok(existsSync(saved));
  assert.equal(readFileSync(join(row.thread_dir, "report.md"), "utf8"), "replacement report\n");
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

const REVIEW_URL = "https://github.com/o/r/pull/10";
for (const kind of ["clean", "dirty", "private commit", "published commit", "reflog commit", "own PR"]) {
  test(`OVNFS review: ${kind} after the reviewed PR merges`, async () => {
    const byFlag = kind === "clean";
    await ovnfsFixture("off", async ({ t, p, pp, id, thread, registry, ...f }) => {
      writeSettings(p, { ...p.settings(), mute: true, nudge: false });
      write(join(t.thread_dir, "report.md"), `${byFlag ? "" : `Reviewed-PR: ${REVIEW_URL}\n\n`}## Report\nDone\n`);
      const progress = pp("report", "--thread", `demo/${id}`, "--percent", "100");
      assert.ok(progress.ok, progress.out);
      if (kind === "dirty") write(join(t.cwd, "package.json"), '{"dirty":true}\n');
      if (kind.endsWith("commit")) git(t.cwd, "commit", "--allow-empty", "-qm", "reviewer change");
      const privateTip = kind === "reflog commit" ? git(t.cwd, "rev-parse", "HEAD") : "";
      if (privateTip) git(t.cwd, "reset", "--hard", "HEAD^");
      if (kind === "published commit") git(f.repo, "fetch", t.cwd, `${t.branch}:refs/heads/published-review`);
      const views = { [REVIEW_URL]: { state: "MERGED" } };
      if (kind === "own PR") {
        const url = "https://github.com/o/r/pull/20";
        Object.assign(f.env, { FAKE_GH_HEAD: t.branch, FAKE_GH_HEAD_PRS: JSON.stringify([{ url, state: "OPEN" }]) });
        views[url] = { state: "OPEN", headRefName: t.branch, headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } };
      }
      const r = await tickOnce(f, new Date().toISOString(), views);
      assert.equal(r.code, 0, r.out);
      assert.equal(thread().reviewed_pr?.state, "MERGED", r.out);
      assert.equal(thread().status, kind === "own PR" ? "open" : "resolved", r.out);
      assert.equal(thread().resolved_reason, kind === "own PR" ? "" : "reviewed PR merged");
      assert.ok(existsSync(t.cwd), kind);
      assert.ok(existsSync(registry), kind);
      if (kind === "dirty") assert.equal(readFileSync(join(t.cwd, "package.json"), "utf8"), '{"dirty":true}\n');
      if (privateTip) assert.ok(git(t.cwd, "reflog", "--format=%H").includes(privateTip));
      else if (kind.endsWith("commit")) assert.equal(git(t.cwd, "log", "-1", "--format=%s"), "reviewer change");
    }, byFlag ? { reviews: REVIEW_URL } : {});
  });
}

test("CLI and ticker: follow reviewed PRs and resolve only the merged, finished reviews", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(join(BASE, "reviews-"));
  const daemon = await fakeDaemon("off");
  t.after(() => { daemon.stop(); rmSync(root, { recursive: true, force: true }); });
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "--allow-empty", "-qm", "base");
  git(repo, "remote", "add", "origin", "https://github.com/o/r");
  const config = join(root, "config.json"), cbm = join(root, "cbm.json");
  write(config, JSON.stringify({ profiles: { fake: { provider: "claude/fake-model" } } }));
  write(cbm, JSON.stringify({ projects: [] }));
  const env = { ...process.env, PP_CONFIG: config, PASEO_URL: daemon.url, PP_CODEBASE_MEMORY_BIN: FAKE_CBM, FAKE_CBM_STATE: cbm, PATH: `${FAKE_GH_DIR}:${process.env.PATH}` };
  const args = [PP, "--root", root];
  const pp = (...argv) => execFileSync(process.execPath, [...args, ...argv], { env, encoding: "utf8", timeout: 10_000 });
  pp("new", "demo", "--repo", repo);
  pp("set", "demo", "mute", "true");
  pp("set", "demo", "nudge", "false");
  const statePath = join(root, "demo", ".state", "ticker.json");
  const context = () => pp("context", "demo", "--peek");
  const show = (id) => JSON.parse(pp("thread", "show", "demo", id, "--json"));
  const ownUrl = "https://github.com/o/r/pull/20";
  const cases = ["report", "flag", "closed", "keep", "commits", "invalid", "both"].map((kind, i) => {
    const url = `https://github.com/o/r/pull/${10 + i}`;
    const useFlag = kind === "flag";
    const started = pp("thread", "start", "demo", "--repo", repo, "--profile", "fake", "--title", kind, "--task", "Review it", ...(useFlag ? ["--reviews", url] : []));
    const row = show(started.match(/started (t-\d+)/)[1]);
    if (useFlag) assert.equal(row.reviews, url);
    const ownLine = kind === "both" ? `PR: ${ownUrl}\n` : "";
    write(join(row.thread_dir, "report.md"), `${ownLine}${useFlag ? "" : `Reviewed-PR: ${kind === "invalid" ? "bad" : url}\n\n`}## Report\nDone\n\n## Next\n`);
    if (kind === "keep") write(join(row.thread_dir, "cleanup.json"), JSON.stringify({ keep: [{ path: ".", why: "inspect later" }] }));
    if (kind === "commits") git(row.cwd, "commit", "--allow-empty", "-qm", "reviewer change");
    pp("report", "--thread", `demo/${row.id}`, "--percent", kind === "flag" ? "50" : "100", "--activity", kind === "flag" ? "Waiting for you" : "Done");
    return { kind, url, row };
  });
  const both = cases.find(({ kind }) => kind === "both");
  async function poll(final = false, ownState = "OPEN") {
    write(statePath, JSON.stringify({ ...JSON.parse(existsSync(statePath) ? readFileSync(statePath, "utf8") : "{}"), last_pr_poll: null }));
    const views = Object.fromEntries(cases.map(({ kind, url }) => [url, { state: final ? (kind === "closed" ? "CLOSED" : "MERGED") : "OPEN", headRefName: "author-branch", headRepository: { name: "fork" }, headRepositoryOwner: { login: "other" } }]));
    // At the last poll the reviewer points to a different, open PR filed by the same gh login.
    if (ownState === "MERGED") views["https://github.com/o/r/pull/21"] = { state: "OPEN" };
    views[ownUrl] = { state: ownState, headRefName: both.row.branch, headRefOid: git(both.row.cwd, "rev-parse", "HEAD"), headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } };
    const gitHub = { FAKE_GH_VIEW: JSON.stringify(views), FAKE_GH_FAIL_HEAD: final ? cases[0].row.branch : "", FAKE_GH_OPEN_OWN: ownState === "MERGED" ? '[{"number":21}]' : "[]" };
    const child = spawn(process.execPath, [...args, "ticker", "run"], { env: { ...env, ...gitHub }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const exited = once(child, "exit");
    try {
      // Each pass also rechecks retained resources before recording the PR poll.
      const until = Date.now() + 15_000;
      while (child.exitCode === null && Date.now() < until) {
        if (JSON.parse(readFileSync(statePath, "utf8")).last_pr_poll) return;
        await delay(50);
      }
      assert.fail(`ticker failed to finish a poll: ${stderr}`);
    } finally { child.kill(); await exited; }
  }
  await poll();
  for (const { kind, row } of cases) {
    const current = show(row.id);
    assert.equal(current.status, "open", kind);
    if (kind !== "invalid") assert.equal(current.reviewed_pr?.state, "OPEN", kind);
  }
  await poll(true);
  assert.equal(show(cases[1].row.id).status, "open", "a waiting reviewer stays open even with a merged PR");
  assert.equal(show(cases[1].row.id).reviewed_pr?.state, "MERGED");
  pp("report", "--thread", `demo/${cases[1].row.id}`, "--percent", "100");
  const closed = cases.find(({ kind }) => kind === "closed");
  write(join(closed.row.thread_dir, "report.md"), `Reviewed-PR: ${closed.url.replace("/o/r/", "/O/R/")}\n\n## Report\nDone\n`);
  await poll(true);
  const stillOpen = show(both.row.id);
  assert.equal(stillOpen.status, "open");
  assert.equal(stillOpen.pr, ownUrl);
  assert.equal(stillOpen.pr_state, "OPEN");
  assert.equal(stillOpen.reviewed_pr?.state, "MERGED");
  assert.ok(existsSync(both.row.cwd));
  await poll(true, "CLOSED");
  const ownClosed = show(both.row.id);
  assert.equal(ownClosed.pr, ownUrl);
  assert.equal(ownClosed.pr_state, "CLOSED");
  assert.equal(ownClosed.reviewed_pr?.state, "MERGED");
  assert.equal(ownClosed.status, "open", "a closed, unmerged own PR blocks reviewed PR auto-resolve");
  assert.ok(existsSync(both.row.cwd));
  assert.notEqual(git(repo, "branch", "--list", both.row.branch), "");
  write(join(both.row.thread_dir, "report.md"), `PR: ${ownUrl}\nReviewed-PR: https://github.com/o/r/pull/21\n\n## Report\nDone\n`);
  await poll(true, "MERGED");
  const ownResolved = show(both.row.id);
  assert.equal(ownResolved.status, "resolved");
  assert.equal(ownResolved.pr, ownUrl);
  assert.equal(ownResolved.pr_state, "MERGED");
  assert.equal(ownResolved.resolved_reason, "merged");
  assert.equal(existsSync(both.row.cwd), false);
  assert.equal(git(repo, "branch", "--list", both.row.branch), "");
  assert.ok(inbox.pendingNudges(new Project(root, "demo")).some((i) => i.subject === ownResolved.id && i.event === "resolved"));
  const digest = context();
  assert.ok(digest.includes(`${ownUrl} merged`));
  for (const { kind, url, row } of cases.filter(({ kind }) => kind !== "both")) {
    const current = show(row.id);
    const staysOpen = ["closed", "invalid"].includes(kind), keepsWorktree = staysOpen || ["keep", "commits"].includes(kind);
    assert.equal(current.status, staysOpen ? "open" : "resolved", kind);
    assert.equal(current.pr, "", kind);
    assert.equal(current.pr_state, "", kind);
    assert.equal(existsSync(row.cwd), keepsWorktree, kind);
    assert.equal(git(repo, "branch", "--list", row.branch) !== "", keepsWorktree, kind);
    if (kind === "commits") assert.match(current.working_copy.disposal.blocker, /commit .*not declared/);
    if (staysOpen) continue;
    assert.equal(current.resolved_reason, "reviewed PR merged", kind);
    assert.ok(digest.includes(`${url} merged`), kind);
  }
  assert.equal((digest.match(/closed without merging/g) ?? []).length, 1, digest);
  assert.equal((digest.match(/`Reviewed-PR:` line is not/g) ?? []).length, 1, digest);
  assert.match(digest, /commit .*not declared for preservation/);
  assert.doesNotMatch(digest, /PR ignored|routine .* prompted/);
  t.diagnostic(digest.split("\n").filter((line) => /closed without merging|was resolved|`Reviewed-PR:` line is not/.test(line)).join("\n"));
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
