import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sh } from "./lib.mjs";

const PIN = "v0.8.0";
const ADMIN = fileURLToPath(new URL("./ovnfs-admin.mjs", import.meta.url));
const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, val]) => b[key] === val);
const fileId = (path) => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };
const nonempty = (s) => typeof s === "string" && s.length > 0;
const stamp = (s) => nonempty(s) && Number.isFinite(Date.parse(s));

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
  const ms = ["new", "snap"].includes(op) ? 30_000 : 5000;
  const r = spawnSync(process.execPath, [ADMIN, ns.state, ns.mount, op, JSON.stringify(args), String(ms)], {
    encoding: "utf8", timeout: ms + 1000, maxBuffer: 17 << 20,
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

function configuredNamespace() {
  const resolveDir = (key) => {
    const path = process.env[key];
    if (!path || !isAbsolute(path)) throw new Error(`OVNFS ${PIN} requires an explicit absolute ${key} for a running local daemon`);
    return realpathSync(path);
  };
  return namespace(resolveDir("OVNFS_STATE"), resolveDir("OVNFS_MOUNT"));
}

// Inventory is not mount or ownership proof. Never use the CLI (including ls),
// which can start a daemon even after an earlier status check succeeded.
export function readInventory() {
  const h = { remote: false };
  local(h);
  const ns = configuredNamespace();
  return { namespace: ns, ...registry(h, ns) };
}

export function preflight(h) {
  local(h);
  const r = sh(["ovnfs", "--json", "version"], undefined, undefined, { timeout: 5000 });
  let version;
  try { if (r.ok) version = JSON.parse(r.stdout); } catch {}
  if (version?.version !== PIN || version.os !== "darwin") throw new Error(`OVNFS ${PIN} for macOS is required; no checkout was allocated`);
  const ns = configuredNamespace();
  admin(h, ns, "status");
  mountCheck(ns);
  return ns;
}

export function plan(t, baseline, ns, parent = null) {
  const nonce = randomUUID(), name = `pp-${nonce}`;
  return { owner: t.id, backend: "ovnfs", phase: "planned", baseline, source: t.repo, machine: t.machine,
    branch: t.branch, path: join(ns.mount, name), nonce, identity: null, blocker: "", depends_on: parent ? [parent.nonce] : [],
    ovnfs: { namespace: ns, name, ...(parent ? { from: { owner: parent.owner, resource: parent.resource, base: parent.ovnfs.from.base, snapshot: parent.identity } } : {}) } };
}

export function snapshotPlan(source, resource) {
  const { owner, baseline, machine, source: repo } = source, nonce = randomUUID();
  return { owner, backend: "ovnfs", resource, phase: "planned", baseline, source: repo, machine, branch: "", path: "", nonce, identity: null, blocker: "",
    depends_on: [source.nonce], ovnfs: { namespace: source.ovnfs.namespace, label: `pp-${nonce}`, from: { checkout: source.identity.name, base: source.identity.base, parent: source.identity.parent } } };
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
  if (ls.checkouts.some((c) => c.name === name || c.path === w.path)) throw new Error("OVNFS checkout name/path already exists; not allocating");
  try { lstatSync(w.path); } catch (e) { if (e.code === "ENOENT") return; throw e; }
  throw new Error(`OVNFS checkout path already exists: ${w.path}`);
}

export function create(h, w) {
  const { namespace: ns, name, label, from } = w.ovnfs;
  if (label) return admin(h, ns, "snap", { checkout: from.checkout, label, wait: true });
  if (from) return admin(h, ns, "new", { snapshot: from.snapshot.id, name });
  return admin(h, ns, "new", { dir: w.source, name, rev: w.baseline, rules: ["hidden *"] });
}

function git(cwd, ...args) {
  const r = sh(["git", "-C", cwd, ...args], undefined, undefined, { timeout: 5000 });
  if (!r.ok) throw new Error(`OVNFS private Git identity check failed at ${cwd}: ${r.out}`);
  return r.stdout.trim();
}

function checkoutIdentity(h, w, creating = false) {
  const { namespace: ns, name, from, started_at } = w.ovnfs;
  if (name !== `pp-${w.nonce}` || w.path !== join(ns.mount, name) || !stamp(started_at)) throw new Error("OVNFS checkout intent does not match its name/path");
  const ls = registry(h, ns);
  if (from && creating) verifySnapshot(ls.snapshots, from.snapshot);
  const found = ls.checkouts.filter((c) => c.name === name || c.path === w.path);
  const c = found[0];
  if (found.length !== 1 || c.name !== name || c.path !== w.path || c.source !== w.source || !nonempty(c.base) || !stamp(c.created) || Date.parse(c.created) < Date.parse(started_at) || c.git !== true || c.jj ||
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
  const identity = { name, base: c.base, created: c.created, parent: c.parent ?? "", git_dir: gd, directory: fileId(w.path), registration: fileId(gd) };
  if (creating) {
    const oid = git(w.path, "rev-parse", "--verify", "HEAD^{commit}");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) || (!from && oid !== w.baseline)) throw new Error(`OVNFS checkout does not match its baseline at ${w.path}`);
    try { writeFileSync(mark, `${w.nonce}\n${oid}\n`, { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    identity.initial_oid = oid;
  } else identity.initial_oid = w.identity?.initial_oid;
  if (!lstatSync(mark).isFile() || readFileSync(mark, "utf8") !== `${w.nonce}\n${identity.initial_oid}\n`) throw new Error(`OVNFS checkout generation does not match at ${w.path}`);
  if (creating && git(w.path, "branch", "--show-current") !== w.branch) git(w.path, "-c", "core.hooksPath=/dev/null", "switch", "-c", w.branch);
  return identity;
}

export function recover(h, w) {
  const { namespace: ns, label, from, started_at, parents } = w.ovnfs;
  if (!label) return checkoutIdentity(h, w, true);
  const s = snapshotRow(registry(h, ns).snapshots, { label, checkout: from.checkout, id: w.identity?.id });
  if (label !== `pp-${w.nonce}` || !stamp(started_at) || Date.parse(s.created) < Date.parse(started_at) || !parents?.includes(s.parent) ||
      (w.identity && !same(w.identity, { ...s, tree: w.identity.tree || "" }))) throw new Error("OVNFS snapshot does not match its original capture intent");
  return s;
}

export function verify(h, w) {
  if (w.phase !== "ready" || !w.identity) throw new Error("OVNFS resource identity is not confirmed");
  if (w.ovnfs.label) verifySnapshot(registry(h, w.ovnfs.namespace).snapshots, w.identity);
  else if (!same(w.identity, checkoutIdentity(h, w))) throw new Error(`OVNFS checkout identity does not match at ${w.path}`);
  return w.path;
}

export function requireSameNamespace(a, b) {
  if (!same(a, b)) throw new Error("OVNFS snapshot belongs to a different namespace");
}
