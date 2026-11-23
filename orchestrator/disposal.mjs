// Registered copies use their own evidence gate. A copy-home result alone never authorizes removal.
import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sh, sha256 } from "./lib.mjs";
import * as gitCopy from "./working-copy.mjs";
import { checkDiscard } from "./cleanup.mjs";

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const inside = (p, root) => p === root || p.startsWith(root + "/");
const fail = (message) => { throw new Error(message); };
function stat(path) {
  try { return lstatSync(path); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function git(cwd, args, what) {
  const r = sh(["git", "--no-replace-objects", ...args], cwd, undefined, { timeout: 120_000 });
  if (!r.ok || r.stderr) fail(`${what}: ${r.out}`);
  return r.stdout;
}
function checkDependencies(project, t, w) {
  const directories = (p) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(p, e.name));
  const overlaps = (p) => typeof p === "string" && isAbsolute(p) && (inside(resolve(p), w.path) || Boolean(stat(p) && inside(realpathSync(p), w.path)));
  try {
    const trash = project.path("..", ".trash");
    const projects = [...directories(project.root), ...(stat(trash) ? directories(trash) : [])];
    let found = false;
    for (const dir of projects) {
      if (!stat(join(dir, "PROJECT.md"))) continue;
      const threads = join(dir, "threads");
      for (const name of readdirSync(threads).filter((n) => /^t-\d{4,}\.json$/.test(n))) {
        const file = join(threads, name);
        const other = JSON.parse(readFileSync(file, "utf8"));
        if (other?.id !== name.slice(0, -5) || (other.working_copies != null && !Array.isArray(other.working_copies))) fail(`invalid thread record ${file}`);
        if (!other.working_copy && other.machine === w.machine && [other.cwd, other.repo].some(overlaps)) fail(`${other.id} uses this worktree`);
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
          if (deps.includes(w.nonce) || (r.machine === w.machine && [r.path, r.source].some(overlaps))) fail(`${other.id} resource ${r.nonce} depends on this worktree`);
        }
      }
    }
    if (!found || overlaps(w.source) || overlaps(project.root)) fail("worktree registration, source or independent evidence location cannot be confirmed");
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

function checkOccupancy(path) {
  const r = spawnSync("lsof", ["-nP", "-F0pn"], { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || r.error || r.stderr || !r.stdout?.endsWith("\0\n")) fail("occupancy probe failed");
  let pid = "", files = 0;
  for (const record of r.stdout.slice(0, -2).split("\0\n")) {
    const [field, name, extra] = record.split("\0");
    if (/^p[1-9]\d*$/.test(field) && name === undefined) pid = field.slice(1);
    else if (pid && /^f.+/.test(field) && name?.startsWith("n") && extra === undefined) {
      files++;
      if (inside(name.slice(1).replace(/ \(deleted\)$/, ""), path) && Number(pid) !== process.pid) fail(`occupied by process ${pid}`);
    } else fail("occupancy probe returned malformed output");
  }
  if (!files) fail("occupancy probe returned no file records");
}

function declaration(project, t, w) {
  const td = [w.thread_dir, t.thread_dir].find((dir) => typeof dir === "string" && dir !== w.path && inside(dir, w.path)) ?? null;
  const decl = td ? join(td, "cleanup.json") : null;
  const st = decl && stat(decl);
  if (!st) {
    const previous = project.path("threads", `${t.id}.cleanup.json`);
    const recorded = t.working_copy?.nonce === w.nonce && stat(previous) ? JSON.parse(readFileSync(previous, "utf8")).declaration : null;
    if (recorded?.error || (recorded?.keep != null && !Array.isArray(recorded.keep))) fail("previous path keeps could not be confirmed");
    return { td, decl, d: {}, keep: w.disposal?.path_keep || Boolean(recorded?.keep?.length) };
  }
  if (!st.isFile() || realpathSync(decl) !== decl) fail("unsafe cleanup.json path");
  const d = JSON.parse(readFileSync(decl, "utf8"));
  if (!d || typeof d !== "object" || Array.isArray(d)) fail("cleanup.json must be an object");
  if (d.keep != null && (!Array.isArray(d.keep) || d.keep.some((e) => typeof e?.path !== "string" || !e.path.trim()))) fail("invalid cleanup.json keep declaration");
  return { td, decl, d, keep: Boolean(d.keep?.length) };
}

function inspect(t, w, { td, decl, d }) {
  const path = w.path;
  const head = git(path, ["rev-parse", "--verify", "HEAD^{commit}"], "cannot inspect HEAD").trim();
  if (!oid.test(head) || !oid.test(w.baseline)) fail("cannot verify commit identity");
  const commits = d.commits ?? [];
  if (!Array.isArray(commits) || commits.some((c) => typeof c !== "string" || !oid.test(c))) fail("cleanup.json commits must be full commit IDs");
  if (stat(join(w.identity.git_dir, "modules"))) fail("worktree Git metadata contains submodule repositories");
  const branch = `refs/heads/${w.branch}`;
  const tips = ["HEAD", branch].flatMap((ref) => git(path, ["reflog", "show", "--format=%H", ref], `cannot inspect ${ref} reflog`).trim().split("\n").filter(Boolean));
  const refs = git(path, ["for-each-ref", "--format=%(objectname)", "refs/bisect", "refs/worktree", "refs/rewritten", branch], "cannot inspect worktree refs").trim().split("\n").filter(Boolean);
  const candidates = [...new Set([head, ...tips, ...refs])];
  if (candidates.some((c) => !oid.test(c))) fail("cannot inspect worktree-local commits");
  const privateCommits = git(path, ["rev-list", ...candidates, `^${w.baseline}`, "--not", ...commits], "cannot inspect private commits").trim();
  if (privateCommits) fail(`commit ${privateCommits.split("\n")[0]} not declared for preservation in cleanup.json commits`);
  const index = git(path, ["ls-files", "-z", "-v", "--stage"], "cannot inspect Git index");
  const tracked = new Map(index.split("\0").filter(Boolean).map((entry) => {
    const match = /^H (100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
    if (!match || match[2].length !== head.length) fail("Git index has hidden, conflicted or unsupported entries");
    return [match[3], { mode: match[1], hash: match[2] }];
  }));
  if (git(path, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=none"], "cannot inspect modified files")) fail("unclassified Git modifications");
  const scope = (p) => p !== path && inside(p, path) && !relative(path, p).split("/").includes(".git")
    && (!relative(path, p).split("/").includes(".paseo-project") || (td && inside(p, td) && p !== td));
  function declared(key) {
    const entries = d[key] ?? [];
    if (!Array.isArray(entries) || entries.some((e) => typeof e?.path !== "string" || !e.path.trim())) fail(`invalid cleanup.json ${key} declaration`);
    return entries.map((entry) => {
      const p = resolve(td, entry.path);
      if (!scope(p) || realpathSync(p) !== p) fail(`unsafe ${key} path: ${entry.path}`);
      if (key === "discard") {
        const item = checkDiscard({ ...t, cwd: path, thread_dir: td }, entry);
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
  return { nonce: w.nonce, repository: sourceIdentity(w), head, commits, files, ignored };
}

const exclusions = (manifest) => manifest.ignored.map((p) => `/${p.replace(/[\\*?[\] ]/g, "\\$&")}\n`).join("");

function verifyEvidence(e, path, manifest) {
  if (e.path !== path || realpathSync(path) !== path || !stat(path)?.isDirectory()) fail("evidence path could not be verified");
  const expected = JSON.stringify(manifest);
  const check = (rel, hash) => {
    const p = join(path, rel);
    if (!stat(p)?.isFile() || realpathSync(p) !== p || sha256(readFileSync(p)) !== hash) fail(`evidence missing or corrupt: ${rel}`);
  };
  if (e.manifest !== sha256(expected)) fail("evidence is stale: checkout contents changed");
  check("manifest.json", e.manifest);
  check("commits.bundle", e.bundle);
  check("excludes", sha256(exclusions(manifest)));
  for (const [rel, hash] of Object.entries(manifest.files)) check(join("files", rel), hash);
}

function evidencePath(project, w) {
  const path = join(realpathSync(project.dir), "disposal-evidence", w.nonce);
  if (inside(path, w.path)) fail("evidence must be outside the worktree");
  return path;
}

function storedManifest(proof, path, nonce) {
  if (!proof || proof.path !== path || realpathSync(path) !== path) fail("no verified evidence for interrupted removal");
  const file = join(path, "manifest.json");
  if (!stat(file)?.isFile() || realpathSync(file) !== file) fail("evidence missing or corrupt: manifest.json");
  const text = readFileSync(file, "utf8");
  if (sha256(text) !== proof.manifest) fail("evidence missing or corrupt: manifest.json");
  const manifest = JSON.parse(text);
  if (manifest.nonce !== nonce) fail("evidence belongs to a different resource");
  verifyEvidence(proof, path, manifest);
  return manifest;
}

function flush(path, recursive = false) {
  if (recursive && lstatSync(path).isDirectory()) for (const name of readdirSync(path)) flush(join(path, name), true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function evidence(project, w, manifest) {
  const path = evidencePath(project, w), root = dirname(path);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) fail("evidence directory is a symbolic link");
  if (stat(path)) fail("evidence exists without a verified record");
  const stage = mkdtempSync(join(root, ".verify-"));
  try {
    const bundle = join(stage, "commits.bundle");
    const source = join(stage, "source.git");
    git(stage, ["init", "--quiet", "--bare", "--initial-branch=main", `--object-format=${manifest.head.length === 64 ? "sha256" : "sha1"}`, source], "could not prepare bundle");
    git(source, ["fetch", "--quiet", "--no-tags", "--", w.path, "HEAD:refs/heads/main", ...manifest.commits.map((c) => `${c}:refs/heads/saved/${c}`)], "could not save commits");
    git(source, ["bundle", "create", bundle, "HEAD", "--all"], "could not create commit bundle");
    rmSync(source, { recursive: true });
    const restored = join(stage, "verify.git");
    git(stage, ["clone", "--quiet", "--mirror", "--", bundle, restored], "could not independently restore commits");
    if (git(restored, ["rev-parse", "HEAD^{commit}"], "could not verify restored HEAD").trim() !== manifest.head) fail("restored commit does not match worktree HEAD");
    for (const c of manifest.commits) if (git(restored, ["rev-parse", `refs/heads/saved/${c}^{commit}`], "could not verify restored commit").trim() !== c) fail(`could not verify restored commit ${c}`);
    if (git(restored, ["rev-parse", "--is-shallow-repository"], "cannot verify restored history").trim() !== "false") fail("restored commits depend on shallow history");
    git(restored, ["fsck", "--full"], "restored commits are incomplete");
    rmSync(restored, { recursive: true });
    for (const rel of Object.keys(manifest.files)) {
      const dst = join(stage, "files", rel);
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(join(w.path, rel), dst, constants.COPYFILE_EXCL);
    }
    const text = JSON.stringify(manifest);
    writeFileSync(join(stage, "manifest.json"), text, { flag: "wx", mode: 0o600 });
    writeFileSync(join(stage, "excludes"), exclusions(manifest), { flag: "wx", mode: 0o600 });
    const e = { path, manifest: sha256(text), bundle: sha256(readFileSync(bundle)) };
    verifyEvidence({ ...e, path: stage }, stage, manifest);
    flush(stage, true);
    renameSync(stage, path);
    flush(root);
    flush(dirname(root));
    return e;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function dispose(project, t, h, w, { keepWorktree, agentArchived, dryRun, save }) {
  const path = w.path;
  let proof = w.disposal?.evidence, pathKeep = w.disposal?.path_keep;
  let phase = ["removing", "unknown", "removed"].includes(w.disposal?.phase) ? "unknown" : "retained";
  const withoutHold = () => {
    const d = declaration(project, t, w);
    pathKeep = d.keep;
    if (pathKeep) fail("explicit path keep applies to this worktree");
    return d;
  };
  try {
    if (keepWorktree || w.kept_worktree) fail("explicit --keep-worktree hold");
    if (!agentArchived) fail("agent archive unconfirmed");
    if (h.remote || w.machine !== t.machine) fail("independent evidence verification for remote worktrees is not supported");
    if (w.owner !== t.id || w.backend !== "git-worktree" || !w.identity || !/^[a-f0-9-]{36}$/.test(w.nonce)) fail("unsupported or unconfirmed resource identity");
    if (!proof && (phase === "unknown" || w.disposal?.phase === "archived")) {
      phase = "unknown";
      fail("previous disposal has no verified evidence");
    }
    if (phase === "unknown" && !stat(path)) {
      const manifest = storedManifest(proof, evidencePath(project, w), w.nonce);
      if (!backendGone(w, manifest)) fail("backend removal could not be verified");
      if (!dryRun && w.disposal.phase !== "removed") save({ phase: "removed", blocker: "", evidence: proof });
      return { gone: true, note: `worktree removal verified: ${path}` };
    }
    gitCopy.verify(h, w);
    const declared = withoutHold();
    checkDependencies(project, t, w);
    checkOccupancy(path);
    const manifest = inspect(t, w, declared);
    if (proof) verifyEvidence(proof, evidencePath(project, w), manifest);
    if (dryRun) return { gone: false, note: `worktree would be archived and removed if evidence verifies: ${path}` };
    proof ??= evidence(project, w, manifest);
    save({ phase: "archived", blocker: "", evidence: proof });
    gitCopy.verify(h, w);
    checkDependencies(project, t, w);
    checkOccupancy(path);
    verifyEvidence(proof, evidencePath(project, w), inspect(t, w, withoutHold()));
    save({ phase: "removing", blocker: "", evidence: proof });
    phase = "unknown";
    // Only already classified paths enter the per-command exclude file; Git still rejects dirty and new untracked files.
    git(w.source, ["-c", `core.excludesFile=${join(proof.path, "excludes")}`, "worktree", "remove", "--", path], "backend worktree removal failed");
    if (!backendGone(w, manifest)) fail("backend removal could not be verified");
    save({ phase: "removed", blocker: "", evidence: proof });
    return { gone: true, note: `worktree removed: ${path}` };
  } catch (e) {
    if (!dryRun) save({ phase, blocker: e.message, ...(pathKeep ? { path_keep: true } : {}), ...(proof ? { evidence: proof } : {}) });
    return { gone: false, note: `worktree kept: ${path}: ${e.message}; thread cleanup retries` };
  }
}
