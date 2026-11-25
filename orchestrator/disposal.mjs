// Registered copies use their own evidence gate. A copy-home result alone never authorizes removal.
import { closeSync, constants, copyFileSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sh, sha256 } from "./lib.mjs";
import * as gitCopy from "./working-copy.mjs";
import * as ovnfs from "./managed-ovnfs.mjs";
import { checkDiscard } from "./cleanup.mjs";
import { ownershipRecords } from "./reconciliation.mjs";

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const inside = (p, root) => p === root || p.startsWith(root + "/");
const fail = (message) => { throw new Error(message); };
function stat(path) {
  try { return lstatSync(path); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
// A recurring status check can defer unusually large repositories to an explicit command.
function statusBudget() {
  const deadline = Date.now() + 5_000;
  let entries = 10_000, bytes = 32 * 1024 * 1024;
  const timeout = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) fail("deletion status check exceeded its budget; inspect with thread cleanup");
    return ms;
  };
  return { timeout, visit(size = 0) {
    if (--entries < 0 || (bytes -= size) < 0) fail("deletion status check exceeded its budget; inspect with thread cleanup");
    timeout();
  } };
}
function git(cwd, args, what, env, budget) {
  const r = sh(["git", "--no-replace-objects", ...args], cwd, undefined, { timeout: budget?.timeout() ?? 120_000, env });
  if (!r.ok || r.stderr) fail(`${what}: ${r.out}`);
  return r.stdout;
}
function checkDependencies(project, t, w, budget, remote) {
  const targets = w.backend === "ovnfs" ? [w.path, w.identity.git_dir] : [w.path];
  const overlaps = (p) => typeof p === "string" && isAbsolute(p) && targets.some((path) => inside(resolve(p), path) || Boolean(stat(p) && inside(realpathSync(p), path)));
  const uses = (record, ...paths) => {
    if (!remote) return record.machine === w.machine && paths.some(overlaps);
    // Check explicit overlaps locally, but only disclose paths scoped to this machine.
    if (record.machine !== w.machine) return paths.some((p) => typeof p === "string" && isAbsolute(p) && targets.some((path) => inside(resolve(p), path)));
    for (const p of paths) if (p) {
      if (!isAbsolute(p)) fail("dependency path is not absolute");
      remote.add(p);
    }
    return false;
  };
  try {
    let found = false;
    for (const { dir, t: other } of ownershipRecords(project, budget?.visit)) {
      const file = join(dir, "threads", `${other.id}.json`);
      if (!other.working_copy && uses(other, other.cwd, other.repo)) fail(`${other.id} uses this worktree`);
      for (const r of [...(other.working_copy ? [other.working_copy] : []), ...(other.working_copies ?? [])]) {
        if (!r || r.owner !== other.id || typeof r.nonce !== "string" || typeof r.machine !== "string") fail(`invalid resource record ${file}`);
        if (dir === project.dir && other.id === t.id && r.nonce === w.nonce) {
          if (found || r.path !== w.path) fail(`ambiguous worktree registration ${file}`);
          found = true;
          continue;
        }
        if (r.phase === "removed" && r.disposal?.phase === "removed") continue;
        const deps = r.depends_on ?? (r.backend === "git-worktree" ? [] : null);
        if (!Array.isArray(deps) || deps.some((id) => typeof id !== "string")) fail(`unconfirmed dependencies in ${file}`);
        if (deps.includes(w.nonce) || uses(r, r.path, r.source)) fail(`${other.id} resource ${r.nonce} depends on this worktree`);
      }
    }
    if (!found || (!remote && (overlaps(w.source) || overlaps(project.root)))) fail("worktree registration, source or independent evidence location cannot be confirmed");
  } catch (e) { fail(`dependency inspection failed: ${e.message}`); }
}

function sourceIdentity(w) {
  const common = git(w.source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "cannot verify backend repository").trimEnd();
  if (common !== dirname(dirname(w.identity.git_dir))) fail("backend repository does not match registration");
  const st = lstatSync(common, { bigint: true });
  if (!st.isDirectory()) fail("backend repository directory could not be verified");
  return `${st.dev}:${st.ino}`;
}

function backendGone(w, manifest) {
  if (stat(w.path) || stat(w.identity.git_dir)) return false;
  if (sourceIdentity(w) !== manifest.repository) fail("backend repository identity changed");
  const listing = git(w.source, ["worktree", "list", "--porcelain", "-z"], "cannot verify backend removal");
  if (!listing.endsWith("\0\0") || listing.slice(0, -2).split("\0\0").some((r) => !r.startsWith("worktree /") || !r.includes("\0"))) fail("malformed backend worktree listing");
  return !listing.split("\0").includes(`worktree ${w.path}`);
}

function checkOccupancy(paths, budget) {
  const r = spawnSync("lsof", ["-nP", "-F0pn"], { encoding: "utf8", timeout: budget?.timeout() ?? 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || r.error || r.stderr || !r.stdout?.endsWith("\0\n")) fail("occupancy probe failed");
  let pid = "", files = 0;
  for (const record of r.stdout.slice(0, -2).split("\0\n")) {
    budget?.timeout();
    const [field, name, extra] = record.split("\0");
    if (/^p[1-9]\d*$/.test(field) && name === undefined) pid = field.slice(1);
    else if (pid && /^f.+/.test(field) && name?.startsWith("n") && extra === undefined) {
      files++;
      if (paths.some((path) => inside(name.slice(1).replace(/ \(deleted\)$/, ""), path)) && Number(pid) !== process.pid) fail(`occupied by process ${pid}`);
    } else fail("occupancy probe returned malformed output");
  }
  if (!files) fail("occupancy probe returned no file records");
}

const threadDirectory = (t, w) => [w.thread_dir, t.thread_dir].find((dir) => typeof dir === "string" && dir !== w.path && inside(dir, w.path)) ?? null;
function previousKeep(project, t, w, budget) {
  const previous = project.path("threads", `${t.id}.cleanup.json`);
  const saved = t.working_copy?.nonce === w.nonce && stat(previous);
  if (saved && (!saved.isFile() || realpathSync(previous) !== previous)) fail("unsafe previous cleanup record");
  if (saved) budget?.visit(saved.size);
  const recorded = saved ? JSON.parse(readFileSync(previous, "utf8")).declaration : null;
  if (recorded?.error || (recorded?.keep != null && !Array.isArray(recorded.keep))) fail("previous path keeps could not be confirmed");
  return w.disposal?.path_keep || Boolean(recorded?.keep?.length);
}
function declaration(project, t, w, budget) {
  const td = threadDirectory(t, w);
  const decl = td ? join(td, "cleanup.json") : null;
  const st = decl && stat(decl);
  if (!st) return { td, decl, d: {}, keep: previousKeep(project, t, w, budget) };
  if (!st.isFile() || realpathSync(decl) !== decl) fail("unsafe cleanup.json path");
  budget?.visit(st.size);
  const d = JSON.parse(readFileSync(decl, "utf8"));
  if (!d || typeof d !== "object" || Array.isArray(d)) fail("cleanup.json must be an object");
  if (d.keep != null && (!Array.isArray(d.keep) || d.keep.some((e) => typeof e?.path !== "string" || !e.path.trim()))) fail("invalid cleanup.json keep declaration");
  return { td, decl, d, keep: Boolean(d.keep?.length) };
}

const ovnfsGitEnv = {
  ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("GIT_")).map((key) => [key, undefined])),
  GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
function checkPrivateGit(w, budget) {
  const { git_dir: root, initial_oid: initial, base } = w.identity;
  if (!oid.test(initial) || !/^[a-zA-Z0-9_-]+$/.test(base)) fail("invalid OVNFS commit or base identity");
  const objects = join(w.ovnfs.namespace.state, "bases", base, "objects");
  if (!stat(join(root, "objects"))?.isSymbolicLink() || realpathSync(join(root, "objects")) !== objects || !stat(objects)?.isDirectory()) {
    fail("unconfirmed OVNFS private Git object store");
  }
  const regular = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "config", "index", "packed-refs", "pp-working-copy", "info/exclude"]);
  const ref = new RegExp(`^(?:[a-f0-9]{${initial.length}}|ref: refs/[^\\r\\n]+)\\n?$`);
  const tips = [];
  const dev = lstatSync(root).dev;
  function walk(dir) {
    for (const raw of readdirSync(dir, { encoding: "buffer" })) {
      const name = raw.toString(), full = join(dir, name), rel = relative(root, full);
      if (!raw.equals(Buffer.from(name))) fail("cannot inspect non-UTF-8 name in OVNFS private Git directory");
      if (rel === "objects") continue;
      const st = lstatSync(full);
      budget?.visit(st.size);
      if (st.dev === dev) {
        if (st.isDirectory() && /^(?:refs(?:\/(?!replace(?:\/|$)).+)?|logs(?:\/refs(?:\/.+)?)?|info)$/.test(rel)) { walk(full); continue; }
        if (st.isFile()) {
          if (regular.has(rel) || (rel.startsWith("refs/") && ref.test(readFileSync(full, "utf8")))) continue;
          if (rel === "logs/HEAD" || rel.startsWith("logs/refs/")) {
            for (const tip of gitCopy.reflogTips(full, initial.length)) tips.push(tip);
            continue;
          }
        }
      }
      fail(`unclassified OVNFS private Git entry: ${rel}`);
    }
  }
  walk(root);
  const keys = git(root, ["config", "--file", join(root, "config"), "--no-includes", "--name-only", "--null", "--list"], "cannot inspect OVNFS private Git config", ovnfsGitEnv, budget).split("\0").filter(Boolean);
  if (keys.some((key) => !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|checkstat|trustctime|untrackedcache|fsmonitor)|extensions\.objectformat|ovnfs\.checkout)$/.test(key))) {
    fail("unsupported OVNFS private Git configuration");
  }
  return tips;
}

function inspect(t, w, { td, decl, d }, budget) {
  const path = w.path, ovn = w.backend === "ovnfs";
  const privateTips = ovn ? checkPrivateGit(w, budget) : [];
  const run = (args, what) => git(path, args, what, ovn ? ovnfsGitEnv : undefined, budget);
  const lines = (s) => s.trim().split("\n").filter(Boolean);
  const head = run(["rev-parse", "--verify", "HEAD^{commit}"], "cannot inspect HEAD").trim();
  const baseline = ovn ? w.identity.initial_oid : w.baseline;
  if (!oid.test(head) || !oid.test(baseline)) fail("cannot verify commit identity");
  const commits = d.commits ?? [];
  if (!Array.isArray(commits) || commits.some((c) => typeof c !== "string" || !oid.test(c))) fail("cleanup.json commits must be full commit IDs");
  if (stat(join(w.identity.git_dir, "modules"))) fail("worktree Git metadata contains submodule repositories");
  const branch = `refs/heads/${w.branch}`;
  const tips = ovn ? [...privateTips, ...lines(run(["rev-list", "--all", "--no-walk=unsorted"], "cannot inspect OVNFS private refs"))]
    : [join(w.identity.git_dir, "logs", "HEAD"), join(dirname(dirname(w.identity.git_dir)), "logs", branch)]
      .flatMap((log) => gitCopy.reflogTips(log, head.length));
  const refs = ovn ? lines(run(["fsck", "--unreachable", "--no-progress"], "cannot inspect OVNFS unreachable objects")).filter((r) => r.startsWith("unreachable commit ")).map((r) => r.slice(19))
    : lines(run(["for-each-ref", "--format=%(objectname)", "refs/bisect", "refs/worktree", "refs/rewritten", branch], "cannot inspect worktree refs"));
  const candidates = [...new Set([head, ...tips, ...refs])];
  if (candidates.some((c) => !oid.test(c))) fail("cannot inspect worktree-local commits");
  const privateCommits = run(["rev-list", ...candidates, `^${baseline}`, "--not", ...commits], "cannot inspect private commits").trim();
  if (privateCommits) fail(`commit ${privateCommits.split("\n")[0]} not declared for preservation in cleanup.json commits`);
  const index = run(["ls-files", "-z", "-v", "--stage"], "cannot inspect Git index");
  const tracked = new Map(index.split("\0").filter(Boolean).map((entry) => {
    const match = /^H (100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
    if (!match || match[2].length !== head.length) fail("Git index has hidden, conflicted or unsupported entries");
    return [match[3], { mode: match[1], hash: match[2] }];
  }));
  if (run(["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"], "cannot inspect modified files")) fail("unclassified Git modifications");
  const scope = (p) => p !== path && inside(p, path) && !relative(path, p).split("/").includes(".git")
    && (!relative(path, p).split("/").includes(".paseo-project") || (td && inside(p, td) && p !== td));
  function declared(key) {
    const entries = d[key] ?? [];
    if (!Array.isArray(entries) || entries.some((e) => typeof e?.path !== "string" || !e.path.trim())) fail(`invalid cleanup.json ${key} declaration`);
    return entries.map((entry) => {
      budget?.visit();
      const p = resolve(td, entry.path);
      if (!scope(p) || realpathSync(p) !== p) fail(`unsafe ${key} path: ${entry.path}`);
      if (key === "discard") {
        const item = checkDiscard({ ...t, cwd: path, thread_dir: td }, entry, { remaining: budget?.timeout });
        if (item.status) fail(`cannot discard ${entry.path}: ${item.reason}`);
        return item;
      }
      return { target: p };
    });
  }
  const saves = declared("save");
  const discards = declared("discard");
  for (const { target, product } of discards) {
    if (saves.some((e) => inside(e.target, target) || inside(target, e.target)) || [decl, join(td, "report.md"), join(td, "brief.md")].some((p) => inside(p, target))) fail(`discard overlaps preserved data: ${target}`);
    if (product && discards.some((e) => inside(product.path, e.target))) fail(`discard product is also discarded: ${product.path}`);
  }
  const files = Object.create(null);
  const ignored = [];
  const device = lstatSync(path).dev;
  function walk(dir) {
    for (const raw of readdirSync(dir, { encoding: "buffer" }).sort(Buffer.compare)) {
      const name = raw.toString();
      if (!raw.equals(Buffer.from(name))) fail(`cannot inspect non-UTF-8 name in ${dir}`);
      const full = join(dir, name);
      const rel = relative(path, full);
      if (rel === ".git") continue;
      const st = lstatSync(full);
      budget?.visit(st.size);
      if (st.dev !== device || name === ".git") fail(`cannot verify dependencies at ${rel}`);
      const entry = tracked.get(rel);
      if (entry) {
        const mode = st.isSymbolicLink() ? "120000" : st.isFile() ? (st.mode & 0o100 ? "100755" : "100644") : "";
        if (mode !== entry.mode) fail(`unclassified Git modifications: ${rel}`);
        const bytes = st.isSymbolicLink() ? readlinkSync(full, { encoding: "buffer" }) : readFileSync(full);
        const hash = createHash(head.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (hash !== entry.hash) fail(`unclassified Git modifications: ${rel}`);
        tracked.delete(rel);
        continue;
      }
      if (st.isDirectory() && walk(full)) continue;
      const report = td && full === join(td, "report.md");
      const product = td && inside(full, join(td, "library"));
      const metadata = td && [join(td, "brief.md"), decl].includes(full);
      const discard = discards.some((e) => inside(full, e.target));
      if (!discard && !report && !product && !metadata && !saves.some((e) => inside(full, e.target))) fail(`unclassified file: ${rel}`);
      if (st.isDirectory()) continue;
      if (!st.isFile() && !(discard && st.isSymbolicLink())) fail(`cannot preserve or discard non-regular file: ${rel}`);
      if (!discard) files[rel] = sha256(readFileSync(full));
      if (/[\r\n]/.test(rel)) fail(`cannot safely encode ignore rule for ${rel}`);
      ignored.push(rel);
    }
    return readdirSync(dir).length > 0;
  }
  walk(path);
  if (tracked.size) fail(`unclassified Git modifications: missing ${tracked.keys().next().value}`);
  return { nonce: w.nonce, repository: ovn ? w.identity.registration : sourceIdentity(w), head, commits, files, ignored };
}

const exclusions = (manifest) => manifest.ignored.map((p) => `/${p.replace(/[\\*?[\] ]/g, "\\$&")}\n`).join("");

function verifyEvidence(e, path, manifest, { budget, durable = false } = {}) {
  if (e.path !== path || realpathSync(path) !== path || !stat(path)?.isDirectory()) fail("evidence path could not be verified");
  const dirs = durable ? new Set([path, dirname(path), dirname(dirname(path))]) : null;
  const check = (rel, hash) => {
    const p = join(path, rel);
    const st = stat(p);
    if (!inside(p, path) || !st?.isFile() || realpathSync(p) !== p) fail(`evidence missing or corrupt: ${rel}`);
    budget?.visit(st.size);
    if (!durable) {
      if (sha256(readFileSync(p)) !== hash) fail(`evidence missing or corrupt: ${rel}`);
      return;
    }
    // A published or recorded hash does not show that repaired bytes are durable.
    // Flush the same file descriptor that supplied the verified bytes.
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || sha256(readFileSync(fd)) !== hash) fail(`evidence missing or corrupt: ${rel}`);
      syncEvidence(fd, p);
      const after = lstatSync(p, { bigint: true });
      if (!after.isFile() || realpathSync(p) !== p || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((key) => before[key] !== after[key])) {
        fail(`evidence changed during sync: ${rel}`);
      }
    } finally { closeSync(fd); }
    for (let dir = dirname(p); dir !== path; dir = dirname(dir)) dirs.add(dir);
  };
  if (e.manifest !== sha256(JSON.stringify(manifest))) fail("evidence is stale: checkout contents changed");
  check("manifest.json", e.manifest);
  check("commits.bundle", e.bundle);
  check("excludes", sha256(exclusions(manifest)));
  for (const [rel, hash] of Object.entries(manifest.files)) check(join("files", rel), hash);
  if (dirs) for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (realpathSync(dir) !== dir) fail(`evidence directory could not be verified: ${dir}`);
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { syncEvidence(fd, dir); } finally { closeSync(fd); }
  }
}

function evidencePath(project, w) {
  const path = join(realpathSync(project.dir), "disposal-evidence", w.nonce);
  if (inside(path, w.path)) fail("evidence must be outside the worktree");
  return path;
}

function storedManifest(proof, path, nonce, budget) {
  if (!proof || typeof proof.manifest !== "string" || !/^[a-f0-9]{64}$/.test(proof.manifest) ||
      ![path, `${path}-${proof.manifest}`].includes(proof.path)) fail("no verified evidence for interrupted removal");
  path = proof.path;
  if (realpathSync(path) !== path) fail("evidence path could not be verified");
  const file = join(path, "manifest.json");
  const st = stat(file);
  if (!st?.isFile() || realpathSync(file) !== file) fail("evidence missing or corrupt: manifest.json");
  budget?.visit(st.size);
  const text = readFileSync(file, "utf8");
  if (sha256(text) !== proof.manifest) fail("evidence missing or corrupt: manifest.json");
  const manifest = JSON.parse(text);
  if (manifest.nonce !== nonce) fail("evidence belongs to a different resource");
  verifyEvidence(proof, path, manifest, { budget });
  return manifest;
}

function syncEvidence(fd, path) {
  try { fsyncSync(fd); }
  catch (e) { throw new Error(`could not durably sync evidence ${path}: ${e.message}`, { cause: e }); }
}

function flush(path, recursive = false) {
  if (recursive && lstatSync(path).isDirectory()) for (const name of readdirSync(path)) flush(join(path, name), true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { syncEvidence(fd, path); } finally { closeSync(fd); }
}

function verifyBundle(w, root, bundle, manifest) {
  const stage = mkdtempSync(join(root, ".restore-"));
  try {
    const run = (cwd, args, what) => git(cwd, args, what, w.backend === "ovnfs" || w.machine ? ovnfsGitEnv : undefined);
    const restored = join(stage, "verify.git");
    run(stage, ["clone", "--quiet", "--mirror", "--", bundle, restored], "could not independently restore commits");
    if (run(restored, ["rev-parse", "HEAD^{commit}"], "could not verify restored HEAD").trim() !== manifest.head) fail("restored commit does not match worktree HEAD");
    for (const c of manifest.commits) if (run(restored, ["rev-parse", `refs/heads/saved/${c}^{commit}`], "could not verify restored commit").trim() !== c) fail(`could not verify restored commit ${c}`);
    if (run(restored, ["rev-parse", "--is-shallow-repository"], "cannot verify restored history").trim() !== "false") fail("restored commits depend on shallow history");
    run(restored, ["fsck", "--full"], "restored commits are incomplete");
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function evidence(project, w, manifest, previous, transfer) {
  const base = evidencePath(project, w), root = dirname(base);
  const hash = sha256(JSON.stringify(manifest));
  if (previous) {
    storedManifest(previous, base, w.nonce);
    if (previous.manifest === hash) {
      if (transfer) verifyBundle(w, root, join(previous.path, "commits.bundle"), manifest);
      return previous;
    }
  }
  // Never replace a published generation, including proof from an earlier failed attempt.
  const generation = `${base}-${hash}`;
  // Recover the original nonce-only layout if it is a candidate for this exact manifest.
  // An unmatched legacy directory remains untouched and is not used as proof.
  const legacy = join(base, "manifest.json");
  const path = !previous && stat(base)?.isDirectory() && realpathSync(base) === base && stat(legacy)?.isFile() && realpathSync(legacy) === legacy && sha256(readFileSync(legacy)) === hash
    ? base : generation;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) fail("evidence directory is a symbolic link");
  if (stat(path)) {
    const bundle = join(path, "commits.bundle");
    if (!stat(path)?.isDirectory() || realpathSync(path) !== path || !stat(bundle)?.isFile() || realpathSync(bundle) !== bundle) fail("unverified published evidence path");
    const proof = { path, manifest: hash, bundle: sha256(readFileSync(bundle)) };
    verifyEvidence(proof, path, manifest);
    verifyBundle(w, root, bundle, manifest);
    // The final deletion gate rechecks and syncs this generation, including its directory entries.
    return proof;
  }
  const stage = mkdtempSync(join(root, ".verify-"));
  try {
    const bundle = join(stage, "commits.bundle");
    if (transfer) writeFileSync(bundle, decodeRemoteBytes(transfer.bundle), { flag: "wx", mode: 0o600 });
    else {
      const source = join(stage, "source.git");
      const run = (cwd, args, what) => git(cwd, args, what, w.backend === "ovnfs" ? ovnfsGitEnv : undefined);
      run(stage, ["init", "--quiet", "--bare", "--initial-branch=main", `--object-format=${manifest.head.length === 64 ? "sha256" : "sha1"}`, source], "could not prepare bundle");
      run(source, ["fetch", "--quiet", "--no-tags", "--", w.path, "HEAD:refs/heads/main", ...manifest.commits.map((c) => `${c}:refs/heads/saved/${c}`)], "could not save commits");
      run(source, ["bundle", "create", bundle, "HEAD", "--all"], "could not create commit bundle");
      rmSync(source, { recursive: true });
    }
    verifyBundle(w, root, bundle, manifest);
    for (const rel of Object.keys(manifest.files)) {
      const dst = join(stage, "files", rel);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      if (transfer) writeFileSync(dst, decodeRemoteBytes(Object.hasOwn(transfer.data, rel) && transfer.data[rel]), { flag: "wx", mode: 0o600 });
      else copyFileSync(join(w.path, rel), dst, constants.COPYFILE_EXCL);
    }
    const text = JSON.stringify(manifest);
    writeFileSync(join(stage, "manifest.json"), text, { flag: "wx", mode: 0o600 });
    writeFileSync(join(stage, "excludes"), exclusions(manifest), { flag: "wx", mode: 0o600 });
    const e = { path, manifest: sha256(text), bundle: sha256(readFileSync(bundle)) };
    verifyEvidence({ ...e, path: stage }, stage, manifest);
    flush(stage, true);
    if (stat(path)) fail("evidence generation appeared during verification");
    renameSync(stage, path);
    flush(root);
    flush(dirname(root));
    return e;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function inspectOvnfs(project, t, h, w, budget) {
  ovnfs.verifyDeletion(h, w, project.root);
  checkDependencies(project, t, w, budget);
  checkOccupancy([w.path, w.identity.git_dir], budget);
  const declared = declaration(project, t, w, budget);
  if (declared.keep) fail("explicit path keep applies to this checkout");
  return inspect(t, w, declared, budget);
}

function retainOvnfs(project, t, h, w, { keepWorktree, holdBlocker, agentArchived, dryRun, scheduled, save }) {
  const resource = w.resource ?? "main";
  if (w.phase === "removed" && w.disposal?.phase === "removed") return { gone: true, note: `OVNFS ${resource} already removed: ${w.path}` };
  const hold = holdBlocker || (keepWorktree || w.kept_worktree ? "explicit --keep-worktree hold" : "");
  const reason = w.ovnfs.label ? "snapshot retained" : "checkout deletion is explicit-only";
  const disposal = w.disposal ?? {};
  const uncertain = ["removing", "unknown"].includes(disposal.phase);
  let check = reason;
  if (uncertain) check = disposal.check_blocker || disposal.blocker || "previous OVNFS removal is unconfirmed";
  else if (!w.ovnfs.label) {
    try {
      if (w.phase !== "ready" || !w.identity) fail("working-copy allocation is unconfirmed");
      if (!agentArchived) fail("agent archive unconfirmed; run thread cleanup explicitly");
      const budget = scheduled ? statusBudget() : undefined;
      inspectOvnfs(project, t, h, w, budget);
      if (disposal.evidence || disposal.phase === "archived") storedManifest(disposal.evidence, evidencePath(project, w), w.nonce, budget);
    } catch (e) { check = e.message; }
  }
  const next = { ...disposal, phase: disposal.phase || "retained", blocker: hold || check };
  delete next.hold_blocker;
  delete next.check_blocker;
  if (hold) Object.assign(next, { hold_blocker: hold, check_blocker: check });
  if (!dryRun && !uncertain && JSON.stringify(next) !== JSON.stringify(disposal)) save(next);
  const detail = [...new Set([hold, check, reason].filter(Boolean))].join("; ");
  return { gone: false, needsAttention: uncertain || check !== reason, note: `OVNFS ${resource} kept: ${w.path || w.identity?.id || w.nonce}: ${detail}` };
}

// Called only by the explicit command under the PP lifecycle lock, never by dispose().
export function deleteOvnfsCheckout(project, t, h, w, save) {
  const previous = w.disposal ?? {};
  const path = evidencePath(project, w);
  let proof = previous.evidence;
  let phase = ["removing", "unknown"].includes(previous.phase) ? "unknown" : "retained";
  const record = (phase, blocker = "") => save({ phase, blocker, ...(proof && { evidence: proof }) });
  try {
    if (phase === "unknown") {
      const manifest = storedManifest(proof, path, w.nonce);
      if (manifest.repository !== w.identity.registration || !ovnfs.checkoutGone(h, w, project.root)) fail("previous OVNFS removal is unconfirmed; will not send another rm");
    } else {
      const inspectNow = () => inspectOvnfs(project, t, h, w);
      const manifest = inspectNow();
      proof = evidence(project, w, manifest, proof);
      verifyEvidence(proof, proof.path, inspectNow(), { durable: true });
      if (w.ovnfs.capture) {
        // Older allocations are registered against a PP-owned capture, not the user's repository.
        ovnfs.preserveCheckout(project, h, w, manifest.head);
        verifyEvidence(proof, proof.path, inspectNow());
        ovnfs.removalPreserved(project, w, manifest.head);
      } else {
        for (const commit of new Set([manifest.head, ...manifest.commits])) {
          const refs = git(w.source, ["for-each-ref", `--contains=${commit}`, "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes"],
            `commit ${commit} is not present in the source repository; push or apply it before deleting the OVNFS checkout`, ovnfsGitEnv);
          if (!refs.trim()) fail(`commit ${commit} is not on a source branch; push or apply it before deleting the OVNFS checkout`);
        }
      }
      record("removing");
      phase = "unknown";
      ovnfs.removeCheckout(h, w);
      if (!ovnfs.checkoutGone(h, w, project.root)) fail("OVNFS removal not confirmed by registry and filesystem");
    }
    record("removed");
    return `OVNFS checkout removed: ${w.path}`;
  } catch (e) {
    record(phase, previous.phase === "unknown" && previous.blocker ? previous.blocker : e.message);
    fail(`OVNFS checkout ${phase === "unknown" ? "removal unconfirmed" : "retained"}: ${e.message}`);
  }
}

function decodeRemoteBytes(value) {
  if (typeof value !== "string") fail("missing SSH evidence bytes");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("invalid SSH evidence bytes");
  return bytes;
}

function remoteManifest(w, manifest) {
  const digest = /^[a-f0-9]{64}$/;
  if (!manifest || manifest.nonce !== w.nonce || !/^\d+:\d+$/.test(manifest.repository) || !oid.test(manifest.head) ||
      !Array.isArray(manifest.commits) || manifest.commits.some((c) => typeof c !== "string" || !oid.test(c) || c.length !== manifest.head.length) ||
      !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) fail("malformed SSH evidence manifest");
  const files = Object.entries(manifest.files);
  if (files.length > 10_000 || files.some(([p, hash]) => !digest.test(hash) || /[\x00-\x1f\x7f\\]/.test(p) || p.split("/").some((part) => !part || [".", "..", ".git"].includes(part))) ||
      JSON.stringify(manifest.ignored) !== JSON.stringify(files.map(([p]) => p))) fail("malformed SSH evidence file list");
  return manifest;
}

function remoteDisposal(project, t, h, w, action, expected) {
  const dependencies = new Set();
  if (action !== "status") checkDependencies(project, t, w, undefined, dependencies);
  const { path, source, identity, nonce, baseline, branch } = w;
  const data = JSON.stringify({ w: { path, source, identity, nonce, baseline, branch }, action, expected, dependencies: [...dependencies],
    td: threadDirectory(t, w), pathKeep: action !== "status" && previousKeep(project, t, w) });
  if (Buffer.byteLength(data) >= 1024 * 1024) fail("SSH cleanup request exceeded its budget");
  const program = readFileSync(new URL("./remote-disposal.cjs", import.meta.url), "utf8");
  const r = h.shell(`NODE_OPTIONS= NODE_PATH= node -e '${program.replace(/'/g, "'\\''")}'`, undefined, data, 60_000, 48 * 1024 * 1024);
  if (!r.ok || r.stderr) fail(`SSH cleanup connection or inspection failed${r.timedOut ? " (timeout)" : ""}${r.stderr ? `: ${r.stderr.trim().slice(0, 512)}` : ""}`);
  let response;
  try { response = JSON.parse(r.stdout); }
  catch { fail("invalid SSH cleanup response"); }
  if (!response || typeof response !== "object" || Array.isArray(response)) fail("invalid SSH cleanup response");
  if (typeof response.error === "string") fail(response.error.slice(0, 4096));
  return response;
}

export function dispose(project, t, h, w, options) {
  if (w.backend === "ovnfs") return retainOvnfs(project, t, h, w, options);
  const { keepWorktree, agentArchived, dryRun, save, holdBlocker } = options;
  const path = w.path;
  const hold = holdBlocker || ((keepWorktree || w.kept_worktree) ? "explicit --keep-worktree hold" : "");
  let proof = w.disposal?.evidence, pathKeep = w.disposal?.path_keep;
  let phase = ["removing", "unknown", "removed"].includes(w.disposal?.phase) ? "unknown" : "retained";
  const retained = (check) => {
    const blocker = hold || check;
    const detail = [...new Set([hold, check].filter(Boolean))].join("; ");
    if (!dryRun) save({ phase, blocker, ...(hold ? { hold_blocker: hold, check_blocker: check } : {}), ...(pathKeep ? { path_keep: true } : {}), ...(proof ? { evidence: proof } : {}) });
    return { gone: false, needsAttention: Boolean(check), note: `worktree kept: ${path}: ${detail}; thread cleanup retries` };
  };
  const withoutHold = () => {
    const d = declaration(project, t, w);
    pathKeep = d.keep;
    if (pathKeep) fail("explicit path keep applies to this worktree");
    return d;
  };
  try {
    if (!agentArchived) fail("agent archive unconfirmed");
    if (w.machine !== t.machine || h.remote !== Boolean(w.machine)) fail("working-copy machine could not be confirmed");
    if (w.owner !== t.id || w.backend !== "git-worktree" || !w.identity || !/^[a-f0-9-]{36}$/.test(w.nonce)) fail("unsupported or unconfirmed resource identity");
    if (!proof && (phase === "unknown" || w.disposal?.phase === "archived")) {
      phase = "unknown";
      fail("previous disposal has no verified evidence");
    }
    if (h.remote) {
      if (w.adoption) fail("historical SSH worktree provenance cannot be verified");
      if (phase === "unknown") {
        const manifest = remoteManifest(w, storedManifest(proof, evidencePath(project, w), w.nonce));
        const status = remoteDisposal(project, t, h, w, "status", manifest);
        if (status.gone === true) {
          if (hold) return retained("");
          verifyBundle(w, dirname(proof.path), join(proof.path, "commits.bundle"), manifest);
          if (!dryRun && w.disposal.phase !== "removed") save({ phase: "removed", blocker: "", evidence: proof });
          return { gone: true, note: `SSH worktree removal verified: ${path}` };
        }
        if (status.gone !== false) fail("SSH backend removal could not be verified");
        fail("previous removal is unconfirmed; will not send another SSH removal without a fenced attempt result");
      }
      if (w.phase !== "ready") fail("SSH worktree is not ready for cleanup");
      const transfer = remoteDisposal(project, t, h, w, dryRun || hold ? "inspect" : "capture");
      pathKeep = transfer.pathKeep === true;
      if (pathKeep) fail("explicit path keep applies to this SSH worktree");
      const manifest = remoteManifest(w, transfer.manifest);
      if (hold) return retained("");
      if (dryRun) return { gone: false, note: `SSH worktree would be archived and removed if evidence verifies: ${path}` };
      if (!transfer.data || typeof transfer.data !== "object" || typeof transfer.bundle !== "string") fail("missing SSH evidence transfer");
      proof = evidence(project, w, manifest, proof, transfer);
      verifyEvidence(proof, proof.path, manifest, { durable: true });
      save({ phase: "archived", blocker: "", evidence: proof });
      save({ phase: "removing", blocker: "", evidence: proof });
      phase = "unknown";
      const result = remoteDisposal(project, t, h, w, "remove", manifest);
      pathKeep = result.pathKeep === true;
      if (pathKeep || typeof result.blocked === "string") {
        phase = "retained";
        fail(pathKeep ? "explicit path keep applies to this SSH worktree" : result.blocked.slice(0, 4096));
      }
      if (result.gone !== true) fail("SSH backend removal could not be verified");
      save({ phase: "removed", blocker: "", evidence: proof });
      return { gone: true, note: `SSH worktree removed: ${path}` };
    }
    if (phase === "unknown" && !stat(path)) {
      const manifest = storedManifest(proof, evidencePath(project, w), w.nonce);
      if (!backendGone(w, manifest)) fail("backend removal could not be verified");
      if (hold) return retained("");
      if (!dryRun && w.disposal.phase !== "removed") save({ phase: "removed", blocker: "", evidence: proof });
      return { gone: true, note: `worktree removal verified: ${path}` };
    }
    gitCopy.verify(h, w);
    const declared = withoutHold();
    checkDependencies(project, t, w);
    checkOccupancy([path]);
    const manifest = inspect(t, w, declared);
    if (proof) storedManifest(proof, evidencePath(project, w), w.nonce);
    if (hold) return retained("");
    if (dryRun) return { gone: false, note: `worktree would be archived and removed if evidence verifies: ${path}` };
    proof = evidence(project, w, manifest, proof);
    gitCopy.verify(h, w);
    checkDependencies(project, t, w);
    checkOccupancy([path]);
    verifyEvidence(proof, proof.path, inspect(t, w, withoutHold()), { durable: true });
    save({ phase: "archived", blocker: "", evidence: proof });
    save({ phase: "removing", blocker: "", evidence: proof });
    phase = "unknown";
    // Only already classified paths enter the per-command exclude file; Git still rejects dirty and new untracked files.
    git(w.source, ["-c", "status.showUntrackedFiles=all", "-c", `core.excludesFile=${join(proof.path, "excludes")}`, "worktree", "remove", "--", path], "backend worktree removal failed");
    if (!backendGone(w, manifest)) fail("backend removal could not be verified");
    save({ phase: "removed", blocker: "", evidence: proof });
    return { gone: true, note: `worktree removed: ${path}` };
  } catch (e) { return retained(e.message); }
}
