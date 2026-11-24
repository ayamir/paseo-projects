import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { preservationTarget, verifyCapture } from "./copy-inputs.mjs";
import { fileURLToPath } from "node:url";
import { isFile, sh, writeAtomic } from "./lib.mjs";
import { lifecycleStdio } from "./lifecycle-lock.mjs";

const PIN = "v0.8.0";
const ADMIN = fileURLToPath(new URL("./ovnfs-admin.mjs", import.meta.url));
const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, val]) => b[key] === val);
const fileId = (path) => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };
const inode = (id) => /^-?\d+:(\d+)$/.exec(id)?.[1];
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function sameCheckout(saved, observed) {
  // Darwin assigns a new device number on remount of the same verified NFS export.
  const savedInode = inode(saved.directory);
  return savedInode && same({ ...saved, directory: savedInode }, { ...observed, directory: inode(observed.directory) });
}
const nonempty = (s) => typeof s === "string" && s.length > 0;
const stamp = (s) => nonempty(s) && Number.isFinite(Date.parse(s));
const inside = (p, root) => p === root || p.startsWith(root + "/");
const RM_FEATURES = ["rm.sticky_snapshots", "rm.keep_commits"];

function local(h) {
  if (h.remote || process.platform !== "darwin") throw new Error(`OVNFS ${PIN} is supported only on local macOS`);
}

function namespace(state, mount) {
  const meta = lstatSync(state);
  const sock = lstatSync(join(state, "admin.sock"));
  if (realpathSync(state) !== state || !meta.isDirectory() || meta.uid !== process.getuid() || (meta.mode & 0o022) !== 0 || !sock.isSocket() || sock.uid !== process.getuid() || (sock.mode & 0o077) !== 0 || dirname(mount) === mount || state === mount) {
    throw new Error(`OVNFS ${PIN} requires a user-owned state directory and private admin socket separate from its mount`);
  }
  return { state, mount, directory: fileId(state) };
}

function admin(h, ns, op, args = {}) {
  local(h);
  if (!same(ns, namespace(ns.state, ns.mount))) throw new Error("OVNFS state directory identity changed");
  const writes = op === "apply" || op === "rm";
  const ms = writes || op === "new" || op === "snap" ? 30_000 : 5000;
  const r = spawnSync(process.execPath, [ADMIN, ns.state, ns.mount, op, JSON.stringify(args), String(ms)], {
    encoding: "utf8", timeout: ms + 1000, maxBuffer: 17 << 20, ...(writes && { stdio: lifecycleStdio() }),
  });
  if (r.status !== 0) throw new Error(`OVNFS ${PIN} ${op}: ${r.error?.message ?? (r.stderr.trim() || "unknown admin outcome")}`);
  if (!same(ns, namespace(ns.state, ns.mount))) throw new Error("OVNFS state directory identity changed");
  return JSON.parse(r.stdout);
}

function mountCheck(ns) {
  const r = sh(["nfsstat", "-f", "JSON", "-m", ns.mount], undefined, undefined, { timeout: 5000 });
  let entries = [];
  try { if (r.ok) entries = Object.values(JSON.parse(r.stdout)).filter((m) => m?.["Mount Point"] === ns.mount); } catch {}
  const params = entries[0]?.["Current mount parameters"]?.["NFS parameters"];
  const socket = join(ns.state, "nfs.sock");
  if (entries.length !== 1 || !Array.isArray(params) || !["vers=3", "ticotsord", `port=${socket}`, `mountport=${socket}`].every((x) => params.includes(x)) ||
      params.filter((p) => /^(?:mount)?port=/.test(p)).length !== 2) throw new Error(`OVNFS mount ${ns.mount} is not the configured local NFS socket`);
}

// The namespace is OVNFS_STATE and OVNFS_MOUNT (either one makes the pair explicit), else what `pp working-copy ovnfs`
// saved for this root. Tests and fixtures always pass their own root, so they cannot reach a user's namespace.
const NAMESPACE_FILE = ".ovnfs.json";
const namespaceFile = (root) => join(root, NAMESPACE_FILE);
const fromEnv = (...keys) => keys.some((key) => process.env[key] !== undefined);
const explicitDir = (key) => {
  const path = process.env[key];
  if (!path || !isAbsolute(path)) throw new Error(`OVNFS ${PIN} requires an explicit absolute ${key} for a running local daemon`);
  return realpathSync(path);
};
const savedDir = (path) => {
  try { return realpathSync(path); } catch { throw new Error(`saved OVNFS namespace path is missing: ${path}`); }
};

/** { state, mount } that this root saved, or null. */
export function savedNamespace(root) {
  const path = namespaceFile(root);
  if (!isFile(path)) return null;
  let saved;
  try { saved = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${path} is not readable: ${e.message}`); }
  if (typeof saved?.state !== "string" || !isAbsolute(saved.state) || typeof saved?.mount !== "string" || !isAbsolute(saved.mount)) throw new Error(`${path} must hold a JSON object with absolute "state" and "mount"`);
  return { state: saved.state, mount: saved.mount };
}
export const hasSavedNamespace = (root) => isFile(namespaceFile(root));

/** `pp working-copy ovnfs --state DIR --mount DIR`: saves the namespace for this root. null (`--off`) removes it and tells whether one was saved. */
export function saveNamespace(root, saved) {
  const path = namespaceFile(root);
  if (!saved) {
    try { unlinkSync(path); } catch (e) { if (e.code !== "ENOENT") throw e; return false; }
    return true;
  }
  for (const key of ["state", "mount"]) if (typeof saved[key] !== "string" || !isAbsolute(saved[key])) throw new Error(`--${key} takes an absolute path`);
  writeAtomic(path, `${JSON.stringify({ state: saved.state, mount: saved.mount }, null, 2)}\n`);
}

/** Where this root's namespace comes from, and whether its pinned local daemon is verified. Never starts one. */
export function describeNamespace(root) {
  // Named before anything is read, so that a failure still says which source it came from.
  const env = fromEnv("OVNFS_STATE", "OVNFS_MOUNT");
  const source = env ? `OVNFS_STATE and OVNFS_MOUNT (set in this environment; they outrank a saved ${namespaceFile(root)})` : hasSavedNamespace(root) ? namespaceFile(root) : "";
  if (!source) return { ok: false, text: `no OVNFS namespace for ${root}: set OVNFS_STATE and OVNFS_MOUNT, or run \`pp working-copy ovnfs --state DIR --mount DIR\` once` };
  try {
    const ns = preflight({ remote: false }, root);
    return { ok: true, text: `OVNFS namespace from ${source}: state ${ns.state}, mount ${ns.mount}; pinned local daemon verified` };
  } catch (e) { return { ok: false, text: `OVNFS namespace from ${source}: ${e.message}` }; }
}

function configuredNamespace(root) {
  if (fromEnv("OVNFS_STATE", "OVNFS_MOUNT")) return namespace(explicitDir("OVNFS_STATE"), explicitDir("OVNFS_MOUNT"));
  const saved = root && savedNamespace(root);
  return namespace(saved ? savedDir(saved.state) : explicitDir("OVNFS_STATE"), saved ? savedDir(saved.mount) : explicitDir("OVNFS_MOUNT"));
}

// Inventory is not mount or ownership proof. Never use the CLI (including ls),
// which can start a daemon even after an earlier status check succeeded.
export function readInventory(root) {
  const h = { remote: false };
  local(h);
  const ns = configuredNamespace(root);
  return { namespace: ns, ...registry(h, ns) };
}

export function preflight(h, root) {
  local(h);
  const r = sh(["ovnfs", "--json", "version"], undefined, undefined, { timeout: 5000 });
  let version;
  try { if (r.ok) version = JSON.parse(r.stdout); } catch {}
  if (version?.version !== PIN || version.os !== "darwin") throw new Error(`OVNFS ${PIN} for macOS is required; no checkout was allocated`);
  const ns = configuredNamespace(root);
  admin(h, ns, "status");
  mountCheck(ns);
  return ns;
}

// OVNFS --rev opens with empty submodules. Reuse the files of an initialized submodule only
// when it matches the requested revision; other submodules can be initialized with Git as usual.
function submoduleTakes(repo, baseline) {
  return git(repo, "ls-tree", "-r", "-z", baseline).split("\0").flatMap((row) => {
    const match = /^160000 commit ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) return [];
    const [, oid, path] = match, cwd = join(repo, path);
    try {
      const dotGit = lstatSync(join(cwd, ".git"));
      if ((!dotGit.isFile() && !dotGit.isDirectory()) || realpathSync(cwd) !== cwd ||
          git(cwd, "rev-parse", "--show-toplevel") !== cwd || git(cwd, "rev-parse", "HEAD") !== oid ||
          git(cwd, "--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")) return [];
    } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; }
    return [`.:${path}`];
  });
}

// The source repository is handed to OVNFS itself: `new` opens the thread's committed baseline on it and keeps
// the folder's ignored build state, so PP packs nothing of its own.
export function plan(t, baseline, ns, parent = null) {
  const nonce = randomUUID(), name = `pp-${nonce}`;
  return { owner: t.id, backend: "ovnfs", phase: "planned", baseline, source: t.repo, machine: t.machine,
    branch: t.branch, path: join(ns.mount, name), nonce, identity: null, blocker: "", depends_on: parent ? [parent.nonce] : [],
    ovnfs: { namespace: ns, name, native: true, ...(parent ? { capture: parent.ovnfs.capture, from: { owner: parent.owner, resource: parent.resource, base: parent.ovnfs.from.base, snapshot: parent.identity } } : {}) } };
}

export function snapshotPlan(source, resource) {
  const { owner, baseline, machine, source: repo } = source, nonce = randomUUID();
  return { owner, backend: "ovnfs", resource, phase: "planned", baseline, source: repo, machine, branch: "", path: "", nonce, identity: null, blocker: "",
    depends_on: [source.nonce], ovnfs: { namespace: source.ovnfs.namespace, capture: source.ovnfs.capture, label: `pp-${nonce}`, from: { checkout: source.identity.name, base: source.identity.base, parent: source.identity.parent } } };
}

function registry(h, ns) {
  const r = admin(h, ns, "ls");
  for (const key of ["checkouts", "snapshots"]) {
    if (r[key] !== null && (!Array.isArray(r[key]) || r[key].some((row) => !row || typeof row !== "object" || Array.isArray(row)))) throw new Error(`invalid OVNFS ${key} registry`);
  }
  return { checkouts: r.checkouts ?? [], snapshots: r.snapshots ?? [] };
}

const snapshotId = (s) => typeof s === "string" && /^s[1-9][0-9]*$/.test(s);
const fingerprint = (s) => ({ id: s.id, checkout: s.checkout, parent: s.parent ?? "", label: s.label, created: s.created, tree: s.tree ?? "" });

function snapshotRow(rows, { label, checkout, id }) {
  const candidates = rows.filter((s) => s.label === label || (id && s.id === id));
  const s = candidates[0];
  if (candidates.length !== 1 || !snapshotId(s.id) || (id && s.id !== id) || s.label !== label || s.checkout !== checkout || !stamp(s.created) ||
      (s.parent != null && !snapshotId(s.parent)) || (s.tree != null && typeof s.tree !== "string")) throw new Error(`OVNFS snapshot identity could not be confirmed for ${label}`);
  return fingerprint(s);
}

function verifySnapshot(rows, expected) {
  if (!expected?.tree || !same(snapshotRow(rows, expected), expected)) throw new Error("OVNFS snapshot fingerprint changed or is not fully hashed");
}

export function ensureAvailable(h, w) {
  const { namespace: ns, name, label, from } = w.ovnfs;
  mountCheck(ns);
  const ls = registry(h, ns);
  if (label) {
    if (label !== `pp-${w.nonce}` || ls.snapshots.some((s) => s.label === label)) throw new Error("OVNFS snapshot label already exists or does not match its intent");
    return [...new Set([from.parent ?? "", ...ls.snapshots.filter((s) => s.checkout === from.checkout && snapshotId(s.id)).map((s) => s.id)])];
  }
  if (from) verifySnapshot(ls.snapshots, from.snapshot);
  else if (!w.ovnfs.native && !w.ovnfs.capture?.oid) throw new Error("OVNFS record has no verified capture; start a new checkout explicitly");
  if (ls.checkouts.some((c) => c.name === name || c.path === w.path)) throw new Error("OVNFS checkout name/path already exists; not allocating");
  try { lstatSync(w.path); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  throw new Error(`OVNFS checkout path already exists: ${w.path}`);
}

export function create(h, w) {
  const { namespace: ns, name, label, from, capture, native } = w.ovnfs;
  if (label) return admin(h, ns, "snap", { checkout: from.checkout, label, wait: true });
  if (from) return admin(h, ns, "new", { snapshot: from.snapshot.id, name });
  if (!native) {
    if (!capture?.oid) throw new Error("OVNFS record has no verified capture; start a new checkout explicitly");
    verifyCapture(capture);
    return admin(h, ns, "new", { dir: capture.path, name, rev: capture.oid, rules: ["hidden *"] });
  }
  if (!oidPattern.test(w.baseline ?? "")) throw new Error("OVNFS opens the thread's committed baseline; no checkout was allocated");
  const take = submoduleTakes(w.source, w.baseline);
  return admin(h, ns, "new", { dir: w.source, name, rev: w.baseline, ...(take.length ? { take } : {}) });
}

function git(cwd, ...args) {
  const r = sh(["git", "-C", cwd, ...args], undefined, undefined, { timeout: 5000 });
  if (!r.ok) throw new Error(`OVNFS private Git identity check failed at ${cwd}: ${r.out}`);
  return r.stdout.trim();
}

function readGeneration(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 36 + 64 + 2) throw new Error(`invalid OVNFS checkout generation marker at ${path}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function publishGeneration(mark, expected, previous) {
  // Stage outside the private Git directory so an interrupted publish leaves no file for snapshots to copy.
  const staged = join(dirname(dirname(mark)), `.pp-generation-${randomUUID()}`);
  writeFileSync(staged, expected, { flag: "wx", mode: 0o600, flush: true });
  try {
    if (previous === null) linkSync(staged, mark);
    else {
      if (readGeneration(mark) !== previous) throw new Error(`OVNFS checkout generation changed at ${mark}`);
      renameSync(staged, mark);
    }
  } finally { rmSync(staged, { force: true }); }
}

function checkoutIdentity(h, w, { creating = false, ls, sourceOfSnapshot } = {}) {
  const { namespace: ns, name, from, started_at } = w.ovnfs;
  if (name !== `pp-${w.nonce}` || w.path !== join(ns.mount, name) || !stamp(started_at)) throw new Error("OVNFS checkout intent does not match its name/path");
  ls ??= registry(h, ns);
  if (from && creating) verifySnapshot(ls.snapshots, from.snapshot);
  const found = ls.checkouts.filter((c) => c.name === name || c.path === w.path);
  const c = found[0];
  if (found.length !== 1 || c.name !== name || c.path !== w.path || c.source !== (w.ovnfs.capture?.path ?? w.source) || !nonempty(c.base) || !stamp(c.created) || Date.parse(c.created) < Date.parse(started_at) || c.git !== true || c.jj ||
      (c.parent ?? "") !== (from?.snapshot.id ?? "") || (from && c.base !== from.base)) {
    throw new Error(`OVNFS checkout identity could not be confirmed at ${w.path}`);
  }
  mountCheck(ns);
  const gitfile = join(w.path, ".git");
  if (!lstatSync(w.path).isDirectory() || realpathSync(w.path) !== w.path || !lstatSync(gitfile).isFile()) throw new Error(`OVNFS checkout path was replaced at ${w.path}`);
  const gd = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(gitfile, "utf8"))?.[1];
  if (!gd || dirname(gd) !== join(ns.state, "git") || realpathSync(gd) !== gd || !lstatSync(gd).isDirectory() || git(w.path, "rev-parse", "--show-toplevel") !== w.path ||
      git(w.path, "rev-parse", "--absolute-git-dir") !== gd || git(w.path, "rev-parse", "--path-format=absolute", "--git-common-dir") !== gd || git(w.path, "config", "--local", "--get-all", "ovnfs.checkout") !== name) {
    throw new Error(`OVNFS private Git identity does not match at ${w.path}`);
  }
  const mark = join(gd, "pp-working-copy");
  const directory = fileId(w.path);
  if (directory.split(":")[0] !== fileId(ns.mount).split(":")[0]) throw new Error(`OVNFS checkout is not on its registered mount at ${w.path}`);
  const oid = creating ? git(w.path, "rev-parse", "--verify", "HEAD^{commit}") : w.identity?.initial_oid;
  if (!oidPattern.test(oid) || (creating && !from && oid !== (w.seed?.oid ?? w.baseline))) throw new Error(`OVNFS checkout does not match its baseline at ${w.path}`);
  const identity = { name, base: c.base, created: c.created, parent: c.parent ?? "", git_dir: gd, directory, registration: fileId(gd), initial_oid: oid };
  const expected = `${w.nonce}\n${oid}\n`;
  const previous = readGeneration(mark);
  if (previous !== expected) {
    if (!creating) throw new Error(`OVNFS checkout generation does not match at ${w.path}`);
    // OVNFS v0.8.0 restores the source checkout's private Git files from the snapshot.
    const source = from && sourceOfSnapshot?.();
    const inherited = source && same(source.ovnfs.namespace, ns) && nonempty(source.identity.git_dir) && dirname(source.identity.git_dir) === dirname(gd) &&
      source.identity.git_dir !== gd && inode(source.identity.registration) && source.identity.registration !== identity.registration &&
      oidPattern.test(source.identity.initial_oid) && previous === `${source.nonce}\n${source.identity.initial_oid}\n`;
    if (from ? !inherited : previous !== null) throw new Error(`OVNFS checkout generation does not match at ${w.path}`);
    publishGeneration(mark, expected, previous);
    if (readGeneration(mark) !== expected) throw new Error(`OVNFS checkout generation does not match at ${w.path}`);
  }
  if (creating && git(w.path, "branch", "--show-current") !== w.branch) git(w.path, "-c", "core.hooksPath=/dev/null", "switch", "-c", w.branch);
  return identity;
}

export function recover(h, w, sourceOfSnapshot) {
  const { namespace: ns, label, from, started_at, parents } = w.ovnfs;
  if (!label) return checkoutIdentity(h, w, { creating: true, sourceOfSnapshot });
  const s = snapshotRow(registry(h, ns).snapshots, { label, checkout: from.checkout, id: w.identity?.id });
  if (label !== `pp-${w.nonce}` || !stamp(started_at) || Date.parse(s.created) < Date.parse(started_at) || !parents?.includes(s.parent) ||
      (w.identity && !same(w.identity, { ...s, tree: w.identity.tree || "" }))) throw new Error("OVNFS snapshot does not match its original capture intent");
  return s;
}

export function verify(h, w) {
  if (w.phase !== "ready" || !w.identity) throw new Error("OVNFS resource identity is not confirmed");
  if (w.ovnfs.label) verifySnapshot(registry(h, w.ovnfs.namespace).snapshots, w.identity);
  else if (!sameCheckout(w.identity, checkoutIdentity(h, w))) throw new Error(`OVNFS checkout identity does not match at ${w.path}`);
  return w.path;
}

function deletionInventory(h, w, root) {
  local(h);
  const { namespace: ns, name, label } = w.ovnfs;
  const gitRoot = join(ns.state, "git");
  if (label || !w.identity || name !== `pp-${w.nonce}` || w.identity.name !== name || w.path !== join(ns.mount, name) ||
      dirname(w.identity.git_dir) !== gitRoot || !lstatSync(gitRoot).isDirectory() || realpathSync(gitRoot) !== gitRoot) {
    throw new Error("OVNFS checkout deletion identity is not confirmed");
  }
  if (!same(ns, configuredNamespace(root))) throw new Error("OVNFS checkout belongs to a different namespace");
  mountCheck(ns);
  const ls = registry(h, ns);
  const { checkouts, snapshots } = ls;
  if (checkouts.some((c) => !nonempty(c.name) || !nonempty(c.path) || !isAbsolute(c.path) || !nonempty(c.source) || !isAbsolute(c.source)) ||
      snapshots.some((s) => !snapshotId(s.id) || !nonempty(s.checkout))) throw new Error("invalid OVNFS dependency registry");
  const parents = new Set(snapshots.map((s) => s.id));
  if ([...checkouts, ...snapshots].some((row) => row.parent != null && row.parent !== "" && !parents.has(row.parent))) {
    throw new Error("OVNFS dependency registry contains an unconfirmed parent");
  }
  return ls;
}

export function verifyDeletion(h, w, root) {
  const ls = deletionInventory(h, w, root);
  if (!sameCheckout(w.identity, checkoutIdentity(h, w, { ls }))) throw new Error("OVNFS checkout identity does not match registration");
  const snapshot = ls.snapshots.find((s) => s.checkout === w.identity.name);
  if (snapshot) throw new Error(`OVNFS snapshot ${snapshot.id} depends on this checkout`);
  const child = ls.checkouts.find((c) => c.name !== w.identity.name && [w.path, w.identity.git_dir].some((root) => inside(c.source, root)));
  if (child) throw new Error(`OVNFS checkout ${child.name} depends on this checkout`);
  // Checked before PP records "removing", so an unsupported daemon leaves the checkout retained rather than unknown.
  const { features } = admin(h, w.ovnfs.namespace, "status");
  if (!RM_FEATURES.every((f) => Array.isArray(features) && features.includes(f))) throw new Error("daemon does not support non-force, snapshot-preserving OVNFS removal");
}

export function preserveCheckout(project, h, w, head) {
  const target = preservationTarget(project, w, head);
  if (target.exists) return;
  const result = admin(h, w.ovnfs.namespace, "apply", { checkout: w.identity.name, branch: target.branch });
  if (result.source !== target.path || result.branch !== target.branch || result.commit !== head ||
      [result.applied, result.merged, result.conflicts].some((items) => items != null && (!Array.isArray(items) || items.length)) ||
      !preservationTarget(project, w, head).exists) throw new Error("OVNFS native preservation branch was not confirmed");
}

export function removalPreserved(project, w, head) {
  if (!preservationTarget(project, w, head).exists) throw new Error("OVNFS native preservation branch is missing");
}

export function removeCheckout(h, w) {
  // shortcut: the pinned backend has no conditional rm; external writers must stay quiescent until OVNFS freezes the checkout.
  return admin(h, w.ovnfs.namespace, "rm", { checkout: w.identity.name, sticky_snapshots: true, keep_commits: true });
}

export function checkoutGone(h, w, root) {
  const { checkouts } = deletionInventory(h, w, root);
  if (checkouts.some((c) => c.name === w.identity.name || c.path === w.path)) return false;
  mountCheck(w.ovnfs.namespace);
  const gone = [w.path, w.identity.git_dir].every((p) => {
    try { lstatSync(p); return false; }
    catch (e) { if (e.code === "ENOENT") return true; throw e; }
  });
  mountCheck(w.ovnfs.namespace); // ENOENT counts only if the mount was still live afterwards.
  return gone;
}

export function requireSameNamespace(a, b) {
  if (!same(a, b)) throw new Error("OVNFS snapshot belongs to a different namespace");
}
