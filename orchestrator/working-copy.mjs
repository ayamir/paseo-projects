// The Git backend owns the linked worktree before Paseo is asked to run an agent in it.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const fileId = `file_id() { stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1"; }`;

export function gitBaseline(h, repo, ref) {
  const r = h.shell(`git rev-parse --verify --end-of-options ${q(`${ref}^{commit}`)}`, repo, undefined, 5000);
  const oid = r.stdout.trim();
  if (!r.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error(`could not resolve worktree base ${ref} to a commit: ${r.out}`);
  return oid;
}

export function plan(t, baseline) {
  const nonce = randomUUID();
  return { owner: t.id, backend: "git-worktree", phase: "planned", baseline, source: t.repo, machine: t.machine,
    branch: t.branch, path: join(dirname(t.repo), `pp-${t.id}-${nonce}`), nonce, identity: null, blocker: "" };
}

const lockReason = (w) => `pp creation ${w.nonce}`;

export function create(h, w) {
  // The Git lock travels with the registration if PP loses the command result.
  return h.shell(`git -c core.hooksPath=/dev/null worktree add --lock --reason ${q(lockReason(w))} -b ${q(w.branch)} -- ${q(w.path)} ${q(w.baseline)}`, w.source);
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
[ "$(git rev-parse HEAD)" = ${q(w.baseline)} ]
git diff --quiet HEAD --
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
  return inspect(h, w, true);
}

export function verify(h, w) {
  const missing = () => new Error(`worktree identity missing or unconfirmed at ${w.path}`);
  if (w.phase !== "ready" || !w.identity) throw missing();
  const found = inspect(h, w, false);
  if (Object.keys(found).some((k) => found[k] !== w.identity[k])) throw new Error(`worktree identity does not match at ${w.path}`);
  return w.path;
}

export function unlockCreation(h, w) {
  const r = h.shell(`if [ "$(cat ${q(join(w.identity.git_dir, "locked"))} 2>/dev/null)" = ${q(lockReason(w))} ]; then git worktree unlock -- ${q(w.path)}; fi`, w.path, undefined, 5000);
  if (!r.ok) throw new Error(`could not release worktree creation lock at ${w.path}: ${r.out}`);
}
