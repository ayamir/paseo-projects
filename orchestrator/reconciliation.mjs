// Discover from backend registrations, never from directory or branch names.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { sha256 } from "./lib.mjs";
import { readInventory } from "./managed-ovnfs.mjs";
import { adoptedGitIdentity, adoptionBase, commitOid, linkedWorktrees, verifyAdoptionBase } from "./working-copy.mjs";

export const isLegacy = (t) => !t.working_copy && ["worktree", "ovnfs"].includes(t.kind);
export const branchIdentityBlocker = (t) => t.kind === "worktree" && t.branch && (isLegacy(t) || t.working_copy?.adoption)
  ? "PP has no recorded branch identity; the branch and its reflog are not eligible for removal" : "";
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

function ownership(project) {
  const dirs = (parent) => readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(parent, e.name));
  const trash = join(project.root, ".trash");
  const trashStat = lstatSync(trash, { throwIfNoEntry: false });
  if (trashStat && !trashStat.isDirectory()) throw new Error("trash folder is not a directory");
  const projects = [...dirs(project.root).filter((p) => p !== trash), ...(trashStat ? dirs(trash) : [])];
  const records = [];
  for (const dir of projects) {
    const manifest = lstatSync(join(dir, "PROJECT.md"), { throwIfNoEntry: false });
    if (!manifest) continue;
    if (!manifest.isFile() || !lstatSync(dir).isDirectory()) throw new Error("project ownership path is not canonical");
    const folder = join(dir, "threads");
    if (!lstatSync(folder).isDirectory()) throw new Error("thread records are not a directory");
    for (const name of readdirSync(folder).filter((n) => /^t-\d{4,}\.json$/.test(n))) {
      const file = join(folder, name);
      if (!lstatSync(file).isFile()) throw new Error("thread record is not a regular file");
      const t = JSON.parse(readFileSync(file, "utf8"));
      if (t?.id !== name.slice(0, -5) || (t.working_copies != null && !Array.isArray(t.working_copies)) ||
          [t.working_copy, ...(t.working_copies ?? [])].filter((w) => w !== undefined && w !== null).some((w) => w.owner !== t.id || typeof w.nonce !== "string")) {
        throw new Error("thread ownership records are incomplete");
      }
      records.push({ dir, t });
    }
  }
  return records;
}

// A legacy Git record predates PP generation markers. Require the old recorded origin
// and the original PP thread directory, not just a current path/branch match.
export function verifyLegacyGit(project, t) {
  if (t.machine || !t.cwd || !t.repo || t.branch_start?.name !== t.branch || !commitOid.test(t.branch_start?.oid ?? "")) throw new Error("saved legacy Git origin is missing");
  const registered = linkedWorktrees(t.repo), path = real(t.cwd);
  const rows = registered.filter((r) => r.path === path);
  if (!rows.length && !registered.some((r) => r.branch === t.branch) && !lstatSync(t.cwd, { throwIfNoEntry: false })) return null;
  if (rows.length !== 1 || rows[0].unavailable || rows[0].branch !== t.branch || !commitOid.test(rows[0].head)) throw new Error("saved legacy Git registration could not be verified");
  const identity = adoptedGitIdentity({ path, source: realpathSync(t.repo), branch: t.branch });
  const dir = join(path, ".paseo-project", `${project.slug}-${t.id}`);
  if (t.thread_dir !== join(t.cwd, ".paseo-project", `${project.slug}-${t.id}`) || realpathSync(t.thread_dir) !== dir || realpathSync(dir) !== dir) throw new Error("original PP thread directory could not be verified");
  const meta = lstatSync(dir, { bigint: true });
  const born = BigInt(identity.registration.split(":")[2]);
  if (!meta.isDirectory() || meta.birthtimeNs < born || adoptionBase({ identity, branch: t.branch }, rows[0].head) !== t.branch_start.oid) throw new Error("legacy checkout no longer matches its PP records");
  return identity;
}

function pending(project, fields, blockers, candidate = "") {
  const action = candidate ? `person: thread adopt ${project.slug} ${fields.owner || "<thread-id>"} --candidate ${candidate} --base ${fields.baseline}` : "verify the resource and its origin; pp will not take ownership without proof";
  return { project: project.slug, phase: "pending-confirmation", owner: "", machine: "", path: "", source: "", ...fields,
    candidate, blockers, actions: [action] };
}

export function legacyResource(project, t, proof) {
  const blocker = t.machine ? "remote identity and origin cannot be verified for adoption" : t.kind === "ovnfs"
    ? "legacy OVNFS namespace, checkout identity and original Git baseline cannot be verified"
    : proof?.blocker || "historical Git registration is missing, changed, or unverified";
  const blockers = ["legacy resource not adopted", ...(!proof?.candidate ? [blocker] : [])];
  const branch = branchIdentityBlocker(t);
  if (branch) blockers.push(branch);
  if (Object.hasOwn(t, "kept_worktree") && t.kept_worktree !== false) blockers.push(t.kept_worktree === true ? "explicit legacy keep" : "legacy keep is unknown");
  return pending(project, { owner: t.id, backend: t.kind === "ovnfs" ? "ovnfs" : "git-worktree", path: t.cwd ?? "", source: t.repo ?? "", machine: t.machine ?? "", ...(proof?.baseline ? { baseline: proof.baseline } : {}) }, blockers, proof?.candidate);
}

const sameNamespace = (a, b) => a?.state === b.state && a.mount === b.mount && a.directory === b.directory;
const displayable = (v) => typeof v === "string" && v.length > 0 && !/[\x00-\x1f\x7f]/.test(v);

function ovnfsInventory(project, records, repos) {
  const { namespace: ns, checkouts, snapshots } = readInventory();
  const saved = records.flatMap(({ t }) => [t.working_copy, ...(t.working_copies ?? [])]).filter((w) => w?.backend === "ovnfs" && sameNamespace(w.ovnfs?.namespace, ns));
  const known = new Map(), items = [];
  for (const c of checkouts) {
    if (!displayable(c.name) || !displayable(c.path) || !isAbsolute(c.path) || c.path !== join(ns.mount, c.name) || c.name.includes("/") || !displayable(c.source) || !isAbsolute(c.source)) throw new Error("unverified inventory row");
    if (known.has(c.name)) throw new Error("ambiguous inventory row");
    const managed = saved.find((w) => w.path === c.path && w.identity?.name === c.name && w.identity.created === c.created && w.identity.base === c.base && w.identity.parent === (c.parent ?? "") && (w.ovnfs?.capture?.path ?? w.source) === c.source);
    const legacy = records.some(({ t }) => isLegacy(t) && t.kind === "ovnfs" && !t.machine && t.cwd === c.path && t.ovnfs_name === c.name && t.ovnfs_created === c.created && t.repo === c.source);
    const origin = managed?.source ?? c.source;
    const source = repos.has(origin) ? origin : "";
    known.set(c.name, source);
    if (source && !managed && !legacy) items.push(pending(project, { backend: "ovnfs", resource: c.name, path: c.path, source }, ["unregistered checkout; OVNFS identity and Git origin cannot be independently verified"]));
  }
  let unresolved = false;
  for (const s of snapshots) {
    if (!/^s[1-9][0-9]*$/.test(s.id ?? "") || !displayable(s.checkout)) throw new Error("unverified snapshot row");
    if (saved.some((w) => w.identity?.id === s.id && w.identity.checkout === s.checkout && w.identity.label === s.label && w.identity.created === s.created && w.identity.parent === (s.parent ?? "") && w.identity.tree === (s.tree ?? ""))) continue;
    const source = known.get(s.checkout);
    if (source) items.push(pending(project, { backend: "ovnfs", resource: s.id, source }, ["unregistered snapshot; OVNFS dependency identity and Git origin cannot be independently verified"]));
    else if (!known.has(s.checkout)) unresolved = true;
  }
  if (unresolved) items.push(pending(project, { backend: "ovnfs" }, ["snapshot registrations exist without a checkout; their project source cannot be verified"]));
  return items;
}

export function discover(project, threads) {
  const items = [], candidates = new Map(), legacy = threads.filter(isLegacy);
  const problem = (backend, source, blocker, machine = "") => items.push(pending(project, { backend, source, machine }, [blocker]));
  let records;
  try { records = ownership(project); }
  catch { problem("unknown", "", "PP ownership records could not be verified; discovery and adoption blocked"); }

  const legacyProofs = new Map();
  const savedGit = (records ?? []).filter(({ t }) => !t.machine).flatMap(({ t }) => [t.working_copy, ...(t.working_copies ?? [])]).filter((w) => w?.backend === "git-worktree");
  const seen = new Set();
  const { settings, error } = project.readLenient();
  if (error) problem("unknown", "", "project repository settings could not be read");
  if (records) for (const repo of settings.repos) {
    const { path, machine } = repo;
    if (machine) { problem("git-worktree", path, "remote worktree discovery is not supported", machine); continue; }
    const source = real(path);
    if (!isAbsolute(source) || seen.has(source)) continue;
    seen.add(source);
    let rows;
    try { rows = linkedWorktrees(source); }
    catch { problem("git-worktree", path, "Git worktree registry could not be read"); continue; }
    for (const row of rows) {
      if (row.path === source) continue;
      const selected = records.filter(({ t }) => !t.machine && [t.cwd, t.repo, ...(t.working_copy ? [t.working_copy.path] : []), ...(t.working_copies ?? []).map((w) => w.path)].some((p) => p && (p === row.path || real(p) === row.path)));
      const original = selected.length === 1 && selected[0].dir === project.dir && selected[0].t;
      const owner = original && isLegacy(original) && original.kind === "worktree" && original.cwd === row.path && original.repo === source && original.branch === row.branch ? original.id : "";
      if (selected.length && !owner) continue; // Never offer a path already associated with any thread or source.
      const fields = { backend: "git-worktree", path: row.path, source, owner };
      let proof;
      try {
        if (row.unavailable || !commitOid.test(row.head)) throw new Error("Git registration is locked, prunable or missing its commit identity");
        let identity;
        try { identity = adoptedGitIdentity({ ...fields, branch: row.branch }); }
        catch { throw new Error("Git registration, linked path or current branch identity could not be verified"); }
        // Moving a linked worktree updates its backlink, not the registration's identity.
        const alreadyOwned = savedGit.some((w) => w.identity?.git_dir === identity.git_dir &&
          (w.identity.registration === identity.registration || identity.registration.startsWith(`${w.identity.registration}:`)));
        const displacedLegacy = records.some(({ t }) => isLegacy(t) && t.kind === "worktree" && !t.machine && t.cwd !== row.path &&
          real(t.repo) === source && t.branch === row.branch);
        if (alreadyOwned || displacedLegacy) throw new Error("registration or historical branch already associated with a PP thread at another path");
        const w = { ...fields, branch: row.branch, identity };
        w.baseline = adoptionBase(w, row.head);
        verifyAdoptionBase(w, w.baseline);
        if (owner && !verifyLegacyGit(project, original)) throw new Error("historical PP Git ownership could not be verified");
        const candidate = sha256(JSON.stringify([project.slug, w, row.head]));
        candidates.set(candidate, candidates.has(candidate) ? null : w);
        proof = { candidate, baseline: w.baseline };
      } catch (e) { proof = { blocker: e.message }; }
      if (owner) legacyProofs.set(owner, proof);
      else items.push(pending(project, { ...fields, ...(proof.baseline ? { baseline: proof.baseline } : {}) }, ["unregistered resource not adopted", ...(proof.blocker ? [proof.blocker] : [])], proof.candidate));
    }
  }
  if (records && (process.env.OVNFS_STATE || process.env.OVNFS_MOUNT || legacy.some((t) => t.kind === "ovnfs" && !t.machine))) {
    try { items.push(...ovnfsInventory(project, records, seen)); }
    catch { problem("ovnfs", "", "OVNFS registry unavailable; requires the explicitly configured, running, pinned local namespace"); }
  }
  return { items: [...legacy.map((t) => legacyResource(project, t, legacyProofs.get(t.id))), ...items], candidates };
}
