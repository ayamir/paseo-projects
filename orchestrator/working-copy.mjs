// The Git backend owns the linked worktree before Paseo is asked to run an agent in it.
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { sh } from "./lib.mjs";

export const commitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const preserveUnmanagedGit = "preserve the work independently and leave this Git resource unmanaged";

const readGit = (path, ...args) => readGitWithInput(path, args);
function readGitWithInput(path, args, input) {
  const env = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).map((k) => [k, undefined]));
  const r = sh(["git", "--no-replace-objects", "-C", path, ...args], undefined, input, {
    env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" }, timeout: 5000,
  });
  if (!r.ok || r.stderr || r.stdout.includes("�")) throw new Error("could not read Git registration or origin");
  return r.stdout.replace(/\n$/, "");
}

export function hasGitBranch(source, branch) {
  const ref = `refs/heads/${branch}`;
  return readGit(source, "for-each-ref", "--count=1", "--format=%(refname)", "--", ref) === ref;
}

export function linkedWorktrees(source) {
  const raw = readGit(source, "worktree", "list", "--porcelain", "-z");
  if (!raw.endsWith("\0\0")) throw new Error("malformed Git worktree registry");
  return raw.slice(0, -2).split("\0\0").map((row) => {
    const [p, ...fields] = row.split("\0");
    const path = p.slice("worktree ".length);
    if (!p.startsWith("worktree ") || !isAbsolute(path)) throw new Error("malformed Git worktree registry");
    const branch = fields.find((f) => f.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? "";
    const head = fields.find((f) => f.startsWith("HEAD "))?.slice(5) ?? "";
    return { path, branch, head, unavailable: fields.some((f) => /^(locked|prunable)( |$)/.test(f)) };
  }).slice(1); // The first entry is the source's main worktree, never an adoption candidate.
}

function birthId(path, isDir) {
  const s = lstatSync(path, { bigint: true });
  if (!(isDir ? s.isDirectory() : s.isFile()) || s.birthtimeNs <= 0n || realpathSync(path) !== path) throw new Error("Git resource has no stable, canonical filesystem identity");
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

export function adoptedGitIdentity({ path, source, branch }) {
  if (!branch || /[\x00-\x1f\x7f]/.test(path) || path === source) throw new Error("adoption requires a canonical linked worktree on a named branch");
  const directory = birthId(path, true), link = birthId(join(path, ".git"), false);
  const git_dir = readGit(path, "rev-parse", "--absolute-git-dir");
  const common = readGit(source, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (readGit(path, "rev-parse", "--show-toplevel") !== path || readGit(path, "rev-parse", "--path-format=absolute", "--git-common-dir") !== common ||
      dirname(git_dir) !== join(common, "worktrees") || readGit(path, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`) {
    throw new Error("Git worktree and source registrations do not agree");
  }
  const repository = birthId(common, true), registration = birthId(git_dir, true), backlink = join(git_dir, "gitdir");
  birthId(backlink, false);
  if (readFileSync(backlink, "utf8").replace(/\n$/, "") !== join(path, ".git")) throw new Error("Git worktree registration does not point back to the worktree");
  for (const file of ["locked", "pp-working-copy"]) {
    if (lstatSync(join(git_dir, file), { throwIfNoEntry: false })) throw new Error("Git registration is locked or has a PP creation marker");
  }
  return { git_dir, directory, registration, link, repository };
}

function reflogEntry(line) {
  const [meta, action = ""] = line.split("\t", 2);
  const match = /^(\S+) (\S+) .+ (-?\d+) [+-]\d{4}$/.exec(meta);
  if (!match || !commitOid.test(match[1]) || !commitOid.test(match[2])) throw new Error("invalid Git reflog entry");
  return [match[1], match[2], action, BigInt(match[3])];
}

export function reflogTips(log, size) {
  try {
    const id = birthId(log, false);
    const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || `${before.dev}:${before.ino}:${before.birthtimeNs}` !== id || before.size <= 0n || before.size > 1024n * 1024n) throw new Error();
      const bytes = Buffer.alloc(Number(before.size));
      let read = 0;
      while (read < bytes.length) {
        const n = readSync(fd, bytes, read, bytes.length - read, read);
        if (!n) throw new Error();
        read += n;
      }
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || birthId(log, false) !== id || bytes.at(-1) !== 10) throw new Error();
      const tips = new Set();
      for (const line of bytes.toString("utf8").slice(0, -1).split("\n")) {
        const [old, next] = reflogEntry(line);
        for (const oid of [old, next]) {
          if (!commitOid.test(oid) || oid.length !== size) throw new Error();
          if (!/^0+$/.test(oid)) tips.add(oid);
        }
      }
      if (!tips.size) throw new Error();
      return [...tips];
    } finally { closeSync(fd); }
  } catch (e) { throw new Error(`Git reflog could not be verified: ${log}`, { cause: e }); }
}

// Plain `git worktree remove` drops this registration's HEAD log. Check both sides of
// every entry (including the oldest predecessor), and discount only shared, retained refs.
export function linkedHeadReflogBlocker(path, identity) {
  try {
    const size = readGit(path, "rev-parse", "--show-object-format") === "sha256" ? 64 : 40;
    const input = reflogTips(join(identity.git_dir, "logs", "HEAD"), size).join("\n") + "\n";
    const privateCommit = readGitWithInput(path, ["rev-list", "--max-count=1", "--single-worktree", "--not",
      "--exclude=refs/bisect/*", "--exclude=refs/rewritten/*", "--exclude=refs/worktree/*", "--glob=refs/*", "--not", "--stdin"], input);
    return privateCommit ? "the linked worktree HEAD reflog contains commits not reachable from any retained ref; preserve the work independently before retrying" : "";
  } catch { return `the linked worktree HEAD reflog could not be verified; ${preserveUnmanagedGit}`; }
}

function reflogPrefix(log, count) {
  birthId(log, false);
  const fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc(4096);
    // The last element may be truncated; read only the required complete entries.
    const lines = buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)).split("\n");
    if (lines.length <= count) throw new Error();
    return lines.slice(0, count).map((line) => {
      const [old, next, action, stamp] = reflogEntry(line);
      return { old, next, action, stamp };
    });
  } finally { closeSync(fd); }
}

export function adoptionBase({ identity, branch }, head) {
  try {
    const [start, reset] = reflogPrefix(join(identity.git_dir, "logs", "HEAD"), 2);
    const [created] = reflogPrefix(join(dirname(dirname(identity.git_dir)), "logs", "refs", "heads", branch), 1);
    const born = BigInt(identity.registration.split(":")[2]) / 1_000_000_000n;
    const contemporaneous = (r) => r.stamp >= born - 1n && r.stamp <= born + 1n;
    const zero = "0".repeat(head.length), base = start.next;
    // A rewrite can fabricate a zero predecessor at the same second. Require the native
    // linked-worktree creation sequence AND the independent branch creation entry.
    if (start.old !== zero || start.action !== "" || reset.old !== base || reset.next !== base || reset.action !== "reset: moving to HEAD" ||
        created.old !== zero || created.next !== base || !created.action.startsWith("branch: Created from ") ||
        ![start, reset, created].every(contemporaneous)) throw new Error();
    return base;
  } catch { throw new Error("Git registration's original checkout commit cannot be verified (native creation logs may be missing or rewritten)"); }
}

export function verifyAdoptionBase(w, base) {
  try {
    for (const path of [w.source, w.path]) {
      if (readGit(path, "rev-parse", "--verify", `${base}^{commit}`) !== base) throw new Error();
      readGit(path, "merge-base", "--is-ancestor", base, "HEAD");
    }
  } catch { throw new Error("adoption base must be a commit in both the source and worktree HEAD histories"); }
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const fileId = `file_id() { stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1"; }`;

export function gitBaseline(h, repo, ref) {
  const r = h.shell(`git --no-replace-objects rev-parse --verify --end-of-options ${q(`${ref}^{commit}`)}`, repo, undefined, 5000);
  const oid = r.stdout.trim();
  if (!r.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`could not resolve worktree base ${ref} to a commit: ${r.out}`);
  return oid;
}

// Linked worktrees keep normal Git checkout semantics. Do not treat executable
// filters as verified inputs for the opt-in dirty seed or declared cache.
export function requireCleanCheckout(h, repo, oid) {
  const unknown = () => new Error("Git checkout filter inputs could not be verified");
  const filters = h.shell(`git config --null --name-only --get-regexp ${q("^filter\\..*\\.(clean|smudge|process|required)$")}`, repo, undefined, 5000);
  if (filters.code === 1 && !filters.stdout && !filters.stderr) return;
  if (!filters.ok || !filters.stdout.endsWith("\0") || filters.stderr) throw unknown();
  const drivers = new Set(filters.stdout.slice(0, -1).split("\0").map((key) => /^filter\.(.+)\.[^.]+$/.exec(key)?.[1]));
  if (drivers.has(undefined)) throw unknown();
  const tree = h.shell(`git --no-replace-objects ls-tree -r --full-tree --name-only -z ${q(oid)}`, repo, undefined, 5000);
  if (!tree.ok || tree.stderr || (tree.stdout && !tree.stdout.endsWith("\0")) || tree.stdout.includes("�")) throw unknown();
  if (!tree.stdout) return;
  const attrs = h.shell(`git --no-replace-objects check-attr --source=${q(oid)} --stdin -z filter`, repo, tree.stdout, 5000);
  if (!attrs.ok || attrs.stderr || !attrs.stdout.endsWith("\0")) throw unknown();
  const entries = tree.stdout.slice(0, -1).split("\0"), groups = attrs.stdout.slice(0, -1).split("\0");
  if (groups.length !== entries.length * 3 || entries.some((file, i) => groups[3 * i] !== file || groups[3 * i + 1] !== "filter")) throw unknown();
  if (entries.some((_, i) => drivers.has(groups[3 * i + 2]))) throw new Error("a configured Git checkout filter may read undeclared local inputs");
}

export function plan(t, baseline) {
  const nonce = randomUUID();
  return { owner: t.id, backend: "git-worktree", phase: "planned", baseline, source: t.repo, machine: t.machine,
    branch: t.branch, path: join(dirname(t.repo), `pp-${t.id}-${nonce}`), nonce, identity: null, blocker: "" };
}

const lockReason = (w) => `pp creation ${w.nonce}`;

export function create(h, w) {
  const oid = w.seed?.oid ?? w.baseline;
  // The Git lock travels with the registration if PP loses the command result.
  // For explicit seed mode, check destination-specific config (includeIf can
  // distinguish Git dirs) before a filter can change seed bytes. Keep ordinary
  // Git checkout semantics, including LFS, otherwise.
  const added = h.shell(`git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false worktree add ${w.seed ? "--no-checkout " : ""}--lock --reason ${q(lockReason(w))} -b ${q(w.branch)} -- ${q(w.path)} ${q(oid)}`, w.source);
  if (!added.ok || !w.seed) return added;
  requireCleanCheckout(h, w.path, oid);
  return h.shell(`git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false reset --hard --quiet ${q(oid)}`, w.path);
}

function inspect(h, w, creation) {
  const r = h.shell(`(
set -e
${fileId}
p=$(pwd -P)
[ "$p" = ${q(w.path)} ]
[ -f .git ]
[ ! -L .git ]
[ "$(git rev-parse --show-toplevel)" = "$p" ]
gd=$(git rev-parse --absolute-git-dir)
common=$(git rev-parse --path-format=absolute --git-common-dir)
[ "$common" = "$(git -C ${q(w.source)} rev-parse --path-format=absolute --git-common-dir)" ]
[ "$(dirname "$gd")" = "$common/worktrees" ]
[ ! -L "$gd" ]
[ "$(cat "$gd/gitdir")" = "$p/.git" ]
${creation ? `[ "$(cat "$gd/locked")" = ${q(lockReason(w))} ]
[ "$(git symbolic-ref HEAD)" = ${q(`refs/heads/${w.branch}`)} ]
[ "$(git --no-replace-objects rev-parse HEAD)" = ${q(w.seed?.oid ?? w.baseline)} ]
git --no-replace-objects -c core.fsmonitor=false diff --no-ext-diff --quiet HEAD --
# Keep a generation marker in the registration after releasing the Git lock.
if [ ! -e "$gd/pp-working-copy" ]; then
  (set -C; printf '%s\\n' ${q(w.nonce)} > "$gd/pp-working-copy")
fi
[ -f "$gd/pp-working-copy" ]
[ ! -L "$gd/pp-working-copy" ]
[ "$(cat "$gd/pp-working-copy")" = ${q(w.nonce)} ]` : ""}
printf '%s\\n' "$gd"
file_id "$p"
file_id "$gd"
if [ -f "$gd/pp-working-copy" ] && [ ! -L "$gd/pp-working-copy" ]; then cat "$gd/pp-working-copy"; fi
)`, w.path, undefined, 5000);
  const [git_dir, directory, registration, generation] = r.stdout.trimEnd().split("\n");
  if (!r.ok || !git_dir || !/^\d+:\d+$/.test(directory) || !/^\d+:\d+$/.test(registration)) {
    throw new Error(`worktree identity could not be verified at ${w.path}`);
  }
  if (generation !== w.nonce) throw new Error(`worktree identity does not match at ${w.path}`);
  return { git_dir, directory, registration };
}

export function recover(h, w) {
  if (w.seed) requireCleanCheckout(h, w.path, w.seed.oid);
  return inspect(h, w, true);
}

export function verify(h, w) {
  const guidance = w.adoption ? `; ${preserveUnmanagedGit}` : "";
  const missing = () => new Error(`worktree identity missing or unconfirmed at ${w.path}${guidance}`);
  if (w.phase !== "ready" || !w.identity) throw missing();
  if (w.adoption && (h.remote || w.adoption.origin?.commit !== w.baseline || w.adoption.origin?.source !== w.source)) throw missing();
  let found;
  if (w.adoption) {
    try { found = adoptedGitIdentity(w); }
    catch { throw missing(); }
  } else found = inspect(h, w, false);
  if (Object.keys(found).some((k) => found[k] !== w.identity[k])) throw new Error(`worktree identity does not match at ${w.path}${guidance}`);
  return w.path;
}

export function unlockCreation(h, w) {
  if (w.adoption) return;
  const r = h.shell(`if [ "$(cat ${q(join(w.identity.git_dir, "locked"))} 2>/dev/null)" = ${q(lockReason(w))} ]; then git worktree unlock -- ${q(w.path)}; fi`, w.path, undefined, 5000);
  if (!r.ok) throw new Error(`could not release worktree creation lock at ${w.path}: ${r.out}`);
}
