// What a resolved thread leaves behind, removed only where it is clearly the thread's and clearly
// disposable: the paths it declared in <thread_dir>/cleanup.json, its worktree, and the Codebase Memory
// indexes rooted in what was removed. One implementation for resolve, `thread cleanup` (retry; with
// --dry-run a preview) and sweep. Every run rewrites threads/<id>.cleanup.json and .cleanup.md.
//
// The one ownership rule: something is the thread's to delete only as a real path, resolved before anything
// is deleted, inside its own folder or a <tmp>/<id>-… folder, clear of every thread folder but the inside of
// its own and of everything it declared kept. An index is the thread's only when its root resolved, before
// the deletion, inside what this run removed, or when an earlier run recorded it failed with the real root and the
// removed folder that proved it, the root still resolving there and the folder still gone. A path that is not
// there proves nothing.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { sh, now, readJson, writeJson, writeAtomic, sha256 } from "./lib.mjs";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const inside = (path, root) => path === root || path.startsWith(root.replace(/\/+$/, "") + "/");
/** The real path, or for a path that is gone, its nearest real ancestor joined with the rest. */
const canon = (p) => { try { return realpathSync(p); } catch { const up = dirname(p); return up === p ? p : join(canon(up), basename(p)); } };
const recordPath = (p, id) => p.path("threads", `${id}.cleanup.json`);
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const THREAD_FILES = new Set(["brief.md", "report.md", "cleanup.json", "library"]);
const OCCUPIED_TRIES = 5; // the archived agent may take a moment to exit
const MAX_REASONS = 8;
const LONG_MS = 600_000; // a worktree with its dependencies can hold hundreds of thousands of files

// ------------------------------------------------------------ declaration

/** `<thread_dir>/cleanup.json`: { discard: [{path, product?, why?}], keep: [{path, why?}] }; else the recorded one. */
export function declaration(project, t, h) {
  const text = t.thread_dir ? h.read(`${t.thread_dir}/cleanup.json`) : null;
  if (text === null) return readJson(recordPath(project, t.id))?.declaration ?? { discard: [], keep: [] };
  let d;
  try { d = JSON.parse(text); } catch (e) { return { discard: [], keep: [], error: `cleanup.json does not parse (${e.message})` }; }
  const list = (x) => (Array.isArray(x) ? x : []).filter((e) => typeof e?.path === "string" && e.path.trim())
    .map((e) => ({ path: e.path, why: String(e.why ?? ""), ...(typeof e.product === "string" ? { product: e.product } : {}) }));
  return { discard: list(d.discard), keep: list(d.keep) };
}

const keepsOf = (t, decl) => decl.keep.map((k) => canon(isAbsolute(k.path) ? k.path : resolvePath(t.thread_dir, k.path)));

/**
 * Whether a declared path is the thread's to delete (see the rule at the top). `keeps`: the real paths it
 * declared kept; `removedBefore`: the targets an earlier run removed, the only proof a missing path was its.
 */
function checkDiscard(t, e, { keeps = [], removedBefore = new Set() } = {}) {
  const abs = isAbsolute(e.path) ? e.path : resolvePath(t.thread_dir, e.path);
  const item = { kind: "discard", target: canon(abs), why: e.why };
  if (t.machine) return { ...item, status: "kept", reason: "declared paths on another machine are not cleaned from here" };
  let st;
  try { st = lstatSync(abs); } catch {
    return removedBefore.has(item.target) ? { ...item, status: "gone" } : { ...item, status: "skipped", reason: "not there, and no earlier run of this thread removed it" };
  }
  if (st.isSymbolicLink()) return { ...item, status: "kept", reason: "is a symbolic link; its target is not the thread's to delete" };
  const real = realpathSync(abs);
  const own = t.kind !== "checkout" && t.cwd ? canon(t.cwd) : null;
  const tmps = [...new Set(["/tmp", tmpdir()].map(canon))];
  const inOwn = own && inside(real, own) && real !== own;
  const inTmp = tmps.some((r) => real !== r && inside(real, r) && relative(r, real).split("/")[0].startsWith(`${t.id}-`));
  if (!inOwn && !inTmp) return { ...item, target: real, status: "kept", reason: `not inside the thread's folder or a ${t.id}-… temp folder` };
  const td = canon(t.thread_dir);
  if (inside(td, real)) return { ...item, target: real, status: "kept", reason: "contains this thread folder" };
  if (real.split("/").includes(".paseo-project") && !inside(real, td)) return { ...item, target: real, status: "kept", reason: "is or is in another thread folder" };
  const holds = sh(["find", real, "-name", ".paseo-project", "-print", "-quit"]);
  if (!holds.ok || holds.stdout.trim()) return { ...item, target: real, status: "kept", reason: holds.ok ? `holds a thread folder: ${holds.stdout.trim()}` : `could not be searched for thread folders: ${holds.out}` };
  const k = keeps.find((x) => inside(x, real) || inside(real, x));
  if (k) return { ...item, target: real, status: "kept", reason: `overlaps the declared keep ${k}` };
  if (inOwn && t.kind === "worktree" && sh(["git", "-C", own, "ls-files", "--", real]).stdout.trim()) return { ...item, target: real, status: "kept", reason: "has tracked files" };
  const lib = join(td, "library");
  if (inside(real, lib) && !e.product) return { ...item, target: real, status: "kept", reason: "is in the library: name the finished product it was made into" };
  if (!e.product) return { ...item, target: real };
  const pAbs = isAbsolute(e.product) ? e.product : resolvePath(t.thread_dir, e.product);
  let ps;
  try { ps = lstatSync(pAbs); } catch { return { ...item, target: real, status: "kept", reason: `its product ${e.product} does not exist` }; }
  const pReal = ps.isSymbolicLink() ? null : realpathSync(pAbs);
  if (!pReal || !ps.isFile() || !ps.size || !inside(pReal, lib) || inside(pReal, real)) return { ...item, target: real, status: "kept", reason: `its product ${e.product} is not a non-empty file of the library outside it` };
  return { ...item, target: real, product: { path: pReal, rel: relative(lib, pReal) } };
}

/** Library paths the final copy leaves out: declared discards with a product, checked as far as they can be before the copy. */
export function libraryExcludes(project, t, h) {
  const lib = t.thread_dir ? join(canon(t.thread_dir), "library") : "";
  const decl = declaration(project, t, h);
  return decl.discard.map((e) => checkDiscard(t, e, { keeps: keepsOf(t, decl) })).filter((d) => !d.status && d.product && inside(d.target, lib) && d.target !== lib).map((d) => relative(lib, d.target));
}

// ------------------------------------------------------------ the worktree

/** Pids with a file or folder open under `dir`; null when lsof is not there to tell. */
function occupants(h, dir) {
  if (!h.shell("command -v lsof").ok) return null;
  const r = h.shell(`lsof -nP -F pn 2>/dev/null | awk -v d=${q(dir)} '/^p/{p=substr($0,2)} /^n/{n=substr($0,2); if (n==d || index(n, d "/")==1) print p}' | sort -u`, undefined, undefined, 60_000);
  return r.stdout.split("\n").filter(Boolean).filter((p) => Number(p) !== process.pid);
}

/** Why `top` may not be removed: [] when everything in it is committed, archived, reinstallable or declared. */
function worktreeReasons(h, t, top, { threadDir, discards }) {
  const reasons = [];
  const sh_ = (s) => h.shell(s, top);
  const gtop = sh_("git rev-parse --show-toplevel");
  if (!gtop.ok || gtop.stdout.trim() !== top) return [`git's top level here is ${gtop.ok ? gtop.stdout.trim() : "missing"}, not the worktree`];
  const listed = h.shell("git worktree list --porcelain", t.repo).stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  if (!listed.includes(top)) return [`not a registered worktree of ${t.repo}`];
  if (listed[0] === top) return ["is the repository's main checkout"];
  if (!sh_("git for-each-ref --count=1 --contains HEAD --format='%(refname)'").stdout.trim()) reasons.push("its HEAD commit is on no branch or tag");
  if (sh_('[ -d "$(git rev-parse --git-dir)/modules" ]').ok) reasons.push("its git folder holds submodule repositories");
  for (const line of sh_("git ls-files -s").stdout.split("\n")) {
    const m = /^160000 \S+ \d\t(.+)$/.exec(line);
    if (m && sh_(`[ -e ${q(`${m[1]}/.git`)} ]`).ok) reasons.push(`submodule ${m[1]} is checked out (its source and objects would go with it)`);
  }
  const gone = (rel) => discards.some((d) => inside(join(top, rel.replace(/\/$/, "")), d));
  const entries = sh_("git status --porcelain=v1 -z --ignored --untracked-files=normal --ignore-submodules=none").stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const code = e.slice(0, 2), rel = e.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the rename's source follows
    if (code === "??") { if (!gone(rel)) reasons.push(`untracked: ${rel}`); continue; }
    if (code !== "!!") { reasons.push(`uncommitted change: ${rel}`); continue; }
    if (gone(rel)) continue;
    if (rel === ".paseo-project/" && threadDir) { reasons.push(...threadDirReasons(sh_, threadDir, discards, top)); continue; }
    if (/(^|\/)node_modules\/$/.test(rel) && reinstallable(sh_, rel)) continue;
    reasons.push(`ignored, not known to be disposable: ${rel}`);
  }
  return reasons;
}

/** A node_modules folder with npm or pnpm install metadata next to a lockfile git tracks. */
function reinstallable(sh_, rel) {
  const dir = rel.replace(/\/$/, ""), parent = dirname(dir);
  const meta = [`${dir}/.package-lock.json`, `${dir}/.modules.yaml`, "node_modules/.modules.yaml", "node_modules/.package-lock.json"].map((f) => `[ -f ${q(f)} ]`).join(" || ");
  const locks = [...LOCKFILES.map((l) => join(parent, l)), ...LOCKFILES].map(q).join(" ");
  return sh_(`[ ! -L ${q(dir)} ] && { ${meta}; } && [ -n "$(git ls-files -- ${locks})" ]`).ok;
}

/** `.paseo-project/` holds only this thread's folder, and that only what the final copy took home. */
function threadDirReasons(sh_, threadDir, discards, top) {
  const names = sh_("ls -A .paseo-project").stdout.split("\n").filter(Boolean);
  const reasons = names.filter((n) => n !== basename(threadDir)).map((n) => `another thread folder: .paseo-project/${n}`);
  const mine = sh_(`ls -A ${q(`.paseo-project/${basename(threadDir)}`)}`).stdout.split("\n").filter(Boolean);
  const declared = (n) => discards.some((d) => inside(join(top, ".paseo-project", basename(threadDir), n), d));
  reasons.push(...mine.filter((n) => !THREAD_FILES.has(n) && !declared(n)).map((n) => `not copied home: .paseo-project/${basename(threadDir)}/${n}`));
  return reasons;
}

/** Removes a worktree with plain `git worktree remove` (never forced) once nothing in it would be lost. */
export async function removeWorktree(h, t, { threadDir = "", discards = [], dryRun = false } = {}) {
  const item = { kind: "worktree", target: t.cwd };
  if (!h.isDir(t.cwd)) {
    const wl = h.shell("git worktree list --porcelain", t.repo);
    if (!wl.ok) return { ...item, status: "failed", reason: `its folder is gone and the worktrees of ${t.repo} cannot be read: ${wl.out}` };
    const paths = wl.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    if (!paths.includes(t.cwd) && !paths.includes(canon(t.cwd))) return { ...item, status: "gone" };
    if (dryRun) return { ...item, status: "gone", note: "its registration would be removed" };
    // Only this worktree's registration: never `git worktree prune`, which is repository-wide.
    const r = h.shell(`git worktree remove -- ${q(t.cwd)}`, t.repo);
    return r.ok ? { ...item, status: "gone", note: "its registration removed" } : { ...item, status: "failed", reason: `its folder is gone but git worktree remove failed: ${r.out}` };
  }
  const top = h.shell("pwd -P", t.cwd).stdout.trim();
  item.real = top;
  let reasons = worktreeReasons(h, t, top, { threadDir, discards });
  if (!reasons.length) {
    for (let i = 0; i < OCCUPIED_TRIES; i++) {
      const pids = occupants(h, top);
      if (!pids) { reasons = ["lsof is not available to check that nothing uses it"]; break; }
      reasons = pids.length ? [`in use by pid ${pids.join(", ")}`] : [];
      if (!pids.length || dryRun) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (reasons.length) return { ...item, status: "kept", reason: listed(reasons) };
  const kib = du(h, top);
  if (dryRun) return { ...item, status: "would-remove", kib };
  const r = h.shell(`git worktree remove -- ${q(top)}`, t.repo, undefined, LONG_MS);
  if (!r.ok) return { ...item, status: h.isDir(top) && !r.timedOut ? "kept" : "failed", reason: r.timedOut ? "git worktree remove timed out part way" : r.out };
  return { ...item, status: h.isDir(top) ? "failed" : "removed", kib, ...(h.isDir(top) ? { reason: "still there after git worktree remove" } : {}) };
}

const listed = (rs) => rs.length > MAX_REASONS ? `${rs.slice(0, MAX_REASONS).join("; ")}; and ${rs.length - MAX_REASONS} more` : rs.join("; ");
const du = (h, path) => { const n = Number(h.shell(`du -sk ${q(path)}`, undefined, undefined, LONG_MS).stdout.split(/\s+/)[0]); return Number.isNaN(n) ? null : n; };

// ------------------------------------------------------------ Codebase Memory indexes

/** The official CLI, `codebase-memory-mcp cli --json <tool> <json>`; PP_CODEBASE_MEMORY_BIN names another binary. */
function cbm(tool, args) {
  const bin = process.env.PP_CODEBASE_MEMORY_BIN || "codebase-memory-mcp";
  const r = sh([bin, "cli", "--json", tool, JSON.stringify(args)], undefined, undefined, { timeout: 120_000 });
  let v;
  try { v = JSON.parse(r.stdout); } catch { throw new Error(`${tool}: ${r.out || "no answer"}`); }
  const text = v?.content?.find?.((c) => c.type === "text")?.text;
  if (v?.isError || !r.ok) throw new Error(`${tool}: ${text ?? r.out}`);
  if (text === undefined) return v;
  try { return JSON.parse(text); } catch { return text; }
}

const rowsOf = (v) => Array.isArray(v) ? (v.length && v.every((x) => typeof x?.name === "string") ? v : [])
  : v && typeof v === "object" ? Object.values(v).map(rowsOf).find((a) => a.length) ?? [] : [];

export function listIndexes() {
  const out = [];
  for (let offset = 0; ;) {
    const v = cbm("list_projects", { format: "json", limit: 500, offset });
    const rows = rowsOf(v);
    if (!rows.length && Number(v?.total) > offset) throw new Error("list_projects: rows not recognised");
    out.push(...rows.map((r) => ({ name: r.name, root: r.root_path ?? "" })));
    if (!(v?.has_more ?? v?.page?.has_more) || !rows.length) return out;
    offset += rows.length;
  }
}

const cbmInstalled = () => Boolean(process.env.PP_CODEBASE_MEMORY_BIN) || sh(["sh", "-c", "command -v codebase-memory-mcp"]).ok;

/** Like canon, but "" when a link on the way leads nowhere: where it pointed is not known. */
const settled = (p) => {
  try { return realpathSync(p); } catch {}
  try { lstatSync(p); return ""; } catch {}
  const up = dirname(p);
  const r = up === p ? "" : settled(up);
  return r && join(r, basename(p));
};

/** Every index with its root resolved now, before anything is deleted: links still say where they point. */
function snapshot() {
  if (!cbmInstalled()) return { skip: "codebase-memory-mcp is not installed" };
  try { return { rows: listIndexes().map((x) => ({ ...x, real: x.root ? settled(x.root) : "" })) }; }
  catch (e) { return { error: e.message }; }
}

/**
 * Deletes the indexes this run proved the thread's: rooted (as resolved before the deletion) inside a folder
 * it removed, or recorded failed by an earlier run (`retry`) with the same root, still resolving to the real
 * root recorded then, under a removed folder still not there. Then lists again to check.
 */
function cleanIndexes(snap, roots, retry, dryRun) {
  if (!snap || (!roots.length && !retry.length)) return [];
  if (snap.skip) return [{ kind: "index", target: "(codebase-memory-mcp)", status: "skipped", reason: snap.skip }];
  if (snap.error) return [{ kind: "index", target: "(list)", status: "failed", reason: `${snap.error}; listed before the removal or not at all, the indexes in what went are not known: delete them by hand` }];
  const owned = [], held = [];
  for (const x of snap.rows) {
    const under = x.real && roots.find((r) => inside(x.real, r));
    if (under) { owned.push({ ...x, under }); continue; }
    const i = retry.find((i) => i.target === x.name && i.root === x.root);
    if (!i) continue;
    const back = (() => { try { lstatSync(i.under); return true; } catch { return false; } })();
    const why = !i.real || !i.under ? "no real root on record from the run that removed its folder"
      : x.real !== i.real ? `its root now resolves to ${x.real || "(unknown)"}, not ${i.real} as when its folder was removed`
      : back ? `${i.under}, removed for it, is there again` : "";
    if (why) held.push({ kind: "index", target: x.name, root: x.root, status: i.real && i.under ? "kept" : "skipped", reason: why });
    else owned.push({ ...x, under: i.under });
  }
  const vanished = retry.filter((i) => !snap.rows.some((x) => x.name === i.target)).map((i) => ({ ...i, status: "gone", reason: undefined }));
  const item = (x, status, reason) => ({ kind: "index", target: x.name, root: x.root, real: x.real, under: x.under, status, reason });
  if (dryRun) return [...owned.map((x) => item(x, "would-remove")), ...held, ...vanished];
  const errors = new Map();
  for (const x of owned) { try { cbm("delete_project", { project: x.name }); } catch (e) { errors.set(x.name, e.message); } }
  let left;
  try { left = new Set(listIndexes().map((x) => x.name)); } catch (e) { return [...owned.map((x) => item(x, "failed", `not checked: ${e.message}`)), ...held, ...vanished]; }
  return [...owned.map((x) => left.has(x.name)
    ? item(x, "failed", errors.get(x.name) ?? "still listed after delete_project")
    : item(x, "removed")), ...held, ...vanished];
}

// ------------------------------------------------------------ one run

/**
 * Checks everything first, lists the indexes, then deletes: declared discards, the worktree, the indexes
 * rooted in what went. Kept and skipped items are decisions, failed ones are errors; none stops the rest.
 */
export async function run(project, t, h, { keepWorktree = false, copyComplete = true, archive = { outcome: "complete" }, dryRun = false, paseoAutoArchive = { on: false } } = {}) {
  const decl = declaration(project, t, h);
  const before = readJson(recordPath(project, t.id))?.items ?? [];
  const removedBefore = new Set(before.filter((i) => i.kind === "discard" && i.status === "removed").map((i) => i.target));
  const retry = before.filter((i) => i.kind === "index" && i.status === "failed" && i.root);
  const own = t.kind !== "checkout" && t.cwd ? canon(t.cwd) : null;
  const keepReason = keepWorktree ? "kept as asked (--keep-worktree)"
    : decl.error ? `${decl.error}; its keep list is unknown`
    : decl.keep.length ? `declared kept: ${decl.keep.map((k) => k.why || k.path).join("; ")}`
    : !copyComplete ? "the final copy was partial (`thread resolve --force` removes it)" : "";
  // A keep is about the folder: once something else removed it, the worktree step records what is there.
  const worktreeKept = t.kind === "worktree" && Boolean(keepReason) && Boolean(t.cwd) && h.isDir(t.cwd);
  const lib = t.thread_dir ? join(canon(t.thread_dir), "library") : "";
  const items = decl.discard.map((e) => {
    const d = checkDiscard(t, e, { keeps: keepsOf(t, decl), removedBefore });
    if (!d.status && worktreeKept && own && inside(d.target, own)) Object.assign(d, { status: "kept", reason: "its worktree is kept" });
    if (!d.status && d.product) {
      const home = project.path("library", t.id, d.product.rel);
      let same = false;
      try { same = sha256(readFileSync(home)) === sha256(readFileSync(d.product.path)); } catch {}
      if (!same && !(dryRun && inside(d.target, lib))) Object.assign(d, { status: "kept", reason: `its product ${d.product.rel} is not archived home unchanged` });
    }
    delete d.product;
    return d;
  });
  // Library discards left behind were not copied home, so the worktree holding them must stay.
  const strandedInLibrary = items.filter((d) => d.status === "kept" && lib && inside(d.target, lib) && h.shell(`[ -e ${q(d.target)} ]`).ok);
  const pending = items.filter((d) => !d.status);
  const tryWorktree = t.kind === "worktree" && t.cwd && !worktreeKept && !strandedInLibrary.length;
  const snap = t.machine || !(pending.length || (tryWorktree && h.isDir(t.cwd)) || retry.length) ? null : snapshot();
  for (const d of pending) {
    d.kib = du(h, d.target);
    if (dryRun) { d.status = "would-remove"; continue; }
    const r = sh(["rm", "-rf", "--", d.target]);
    d.status = r.ok && !h.shell(`[ -e ${q(d.target)} ]`).ok ? "removed" : "failed";
    if (d.status === "failed") d.reason = r.out || "still there after rm";
  }
  const discards = items.filter((d) => ["removed", "gone", "would-remove"].includes(d.status)).map((d) => d.target);
  if (t.kind === "worktree" && t.cwd) {
    if (worktreeKept) items.push({ kind: "worktree", target: t.cwd, status: "kept", reason: keepReason });
    else if (strandedInLibrary.length) items.push({ kind: "worktree", target: t.cwd, status: "kept", reason: `not copied home: ${strandedInLibrary.map((d) => d.target).join(", ")}` });
    else {
      try { items.push(await removeWorktree(h, t, { threadDir: t.thread_dir, discards, dryRun })); }
      catch (e) { items.push({ kind: "worktree", target: t.cwd, status: "failed", reason: e.message }); }
    }
  }
  const wt = items.find((i) => i.kind === "worktree");
  if (wt?.status === "kept" && paseoAutoArchive.on) wt.reason += "; but Paseo's daemon.autoArchiveAfterMerge is on: once its pull request merges Paseo removes it with --force, without these checks (turned off, pp alone removes worktrees)";
  if (wt?.status === "kept" && paseoAutoArchive.on === null) wt.reason += `; whether Paseo's daemon.autoArchiveAfterMerge removes it once its pull request merges is unknown (${paseoAutoArchive.why})`;
  // Only what this run removed: a path that was already gone proves nothing about what an index pointed at.
  const roots = items.filter((i) => ["removed", "would-remove"].includes(i.status)).map((i) => i.real ?? i.target);
  items.push(...cleanIndexes(snap, roots, retry, dryRun));
  const result = { notes: items.map(note), worktreeGone: Boolean(wt && ["removed", "gone"].includes(wt.status)), items };
  if (!dryRun) record(project, t, items, decl, archive);
  return result;
}

const note = (i) => {
  const name = i.kind === "worktree" ? "worktree" : i.kind === "index" ? `index ${i.target}` : i.target;
  const size = i.kib != null && i.status !== "kept" ? ` (${i.kib} KiB)` : "";
  if (i.status === "would-remove") return `${name} would be removed${size}`;
  if (i.status === "gone") return `${name} was already gone${i.note ? `; ${i.note}` : ""}`;
  return `${name} ${i.status}${size}${i.reason ? `: ${i.reason}` : ""}`;
};

/** threads/<id>.cleanup.json and .md; an item removed by an earlier run keeps that run's entry. `state` is the cleanup's, `archive` the final copy's. */
function record(project, t, items, decl, archive) {
  const prev = readJson(recordPath(project, t.id));
  const before = new Map((prev?.items ?? []).map((i) => [`${i.kind} ${i.target}`, i]));
  const at = now();
  const merged = items.map((i) => {
    const old = before.get(`${i.kind} ${i.target}`);
    return i.status === "gone" && old?.status === "removed" ? old : { ...i, at };
  });
  // Indexes are listed fresh each run; a removed one no longer shows, so carry it over.
  for (const old of prev?.items ?? []) if (old.kind === "index" && old.status === "removed" && !merged.some((i) => i.kind === "index" && i.target === old.target)) merged.push(old);
  const failed = merged.filter((i) => i.status === "failed").length;
  const rec = {
    thread: t.id, project: project.slug, run: (prev?.run ?? 0) + 1, at, state: failed ? "partial" : "complete",
    archive: archive.outcome, archive_agent: t.agent_id ?? "", ...(archive.missing?.length ? { archive_missing: archive.missing } : {}), ...(archive.unknown?.length ? { archive_unknown: archive.unknown } : {}),
    removed_kib: merged.filter((i) => i.status === "removed").reduce((s, i) => s + (i.kib ?? 0), 0),
    measure: "du -sk before removal; shared or cloned blocks mean it is not a promise of freed disk",
    items: merged, declaration: decl,
  };
  writeJson(recordPath(project, t.id), rec);
  const rows = merged.map((i) => `| ${i.kind} | \`${i.target}\` | ${i.status} | ${i.kib ?? ""} | ${(i.reason ?? i.why ?? "").replace(/\|/g, "\\|")} |`);
  writeAtomic(project.path("threads", `${t.id}.cleanup.md`), `# ${t.id} cleanup\n\nRun ${rec.run} at ${at}: **${rec.state}**${failed ? ` (${failed} failed; \`pp thread cleanup ${project.slug} ${t.id}\` retries)` : ""}; archive **${rec.archive}**${rec.archive_missing ? ` (not copied home: ${rec.archive_missing.join(", ")})` : ""}${rec.archive_unknown ? ` (completeness unknown: ${rec.archive_unknown.join(", ")})` : ""}. Removed ${rec.removed_kib} KiB (${rec.measure}).\n\n| Kind | Target | Result | KiB | Reason |\n|---|---|---|---|---|\n${rows.join("\n")}\n`);
}
