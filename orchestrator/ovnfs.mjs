// OVNFS owns the mount and checkout registry. PP only removes a checkout whose saved identity still matches.
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sh } from "./lib.mjs";

function pathGone(cwd) {
  try { lstatSync(cwd); } catch (e) { if (e.code === "ENOENT") return true; throw e; }
  return false;
}

export const checkoutName = () => `pp-${randomUUID()}`;
const git = (cwd, args) => sh(["git", "-C", cwd, ...args], undefined, undefined, {
  timeout: 15_000, env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
});

function command(args) {
  const r = sh(["ovnfs", ...args], undefined, undefined, { timeout: 120_000, env: { OVNFS_GIT_REMOTES: "0" } });
  if (!r.ok) throw new Error(`ovnfs ${args.filter((a) => a !== "--json")[0]}: ${r.out || (r.timedOut ? "timed out" : "failed to run; check that ovnfs is on PATH")}`);
  return r.stdout;
}

function lookup(t) {
  if (t.machine || !/^pp-[0-9a-f-]{36}$/.test(t.ovnfs_name ?? "") || !isAbsolute(t.repo)) throw new Error("invalid local OVNFS checkout record");
  const { checkouts } = JSON.parse(command(["--json", "ls", t.repo]));
  if (checkouts !== null && !Array.isArray(checkouts)) throw new Error("unexpected OVNFS checkout list");
  const match = (checkouts ?? []).filter((c) => c.name === t.ovnfs_name);
  if (match.length > 1) throw new Error("ambiguous OVNFS checkout name");
  const c = match[0];
  if (c && (c.git !== true || typeof c.created !== "string" || !c.created || !isAbsolute(c.path) || realpathSync(c.source) !== realpathSync(t.repo))) {
    throw new Error("OVNFS checkout does not match its source repository");
  }
  return c;
}

export function prepare(t) {
  let c = lookup(t);
  if (!c) {
    command(["--json", "new", t.repo, "--name", t.ovnfs_name, `--rev=${t.base || "HEAD"}`]);
    c = lookup(t);
  }
  if (!c) throw new Error("OVNFS did not register the new checkout");
  const { cwd, gitDir } = verifyMount(t, c.path);
  return { cwd, ovnfs_created: c.created, ovnfs_git_dir: gitDir };
}

function verifyMount(t, path) {
  const repo = t.repo;
  if (!lstatSync(path).isDirectory()) throw new Error("OVNFS checkout is not mounted as a directory");
  const cwd = realpathSync(path);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const dir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const source = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (cwd === realpathSync(repo) || !top.ok || top.stdout.trim() !== cwd || !dir.ok || !common.ok || !source.ok) {
    throw new Error("OVNFS checkout is not a separate Git repository at its registered path");
  }
  const gitDir = realpathSync(dir.stdout.trim());
  const marker = git(cwd, ["config", "--local", "--get", "ovnfs.checkout"]);
  if (gitDir !== realpathSync(common.stdout.trim()) || gitDir === realpathSync(source.stdout.trim()) || !marker.ok || marker.stdout.trim() !== t.ovnfs_name) {
    throw new Error("OVNFS checkout does not have private Git state");
  }
  return { cwd, gitDir };
}

// A missing registration and a missing path together prove that a saved checkout is gone.
export function mounted(t) {
  const c = lookup(t);
  if (!c) {
    if (pathGone(t.cwd)) return null;
    throw new Error("OVNFS checkout is unregistered but its path still exists");
  }
  const { cwd, gitDir } = verifyMount(t, c.path);
  if (c.created !== t.ovnfs_created || cwd !== t.cwd || gitDir !== t.ovnfs_git_dir) {
    throw new Error("OVNFS checkout identity changed");
  }
  return t.cwd;
}

export function createBranch(cwd, branch) {
  const current = git(cwd, ["branch", "--show-current"]);
  if (!current.ok || current.stdout.trim() !== branch) {
    const r = git(cwd, ["switch", "-c", branch]);
    if (!r.ok) throw new Error(`could not create branch ${branch}: ${r.out}`);
  }
  const tip = git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (!tip.ok) throw new Error(`could not read branch ${branch}: ${tip.out}`);
  return tip.stdout.trim();
}

/** Checkout refs are private. Prove their commits exist on source refs or in the verified merged PR. */
export function commitReason(t, mergedHead) {
  const head = git(t.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const refs = git(t.cwd, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  if (!head.ok || !refs.ok) return "could not check its Git commits";
  const lines = refs.stdout.trim().split("\n").filter(Boolean);
  if (lines.some((line) => line.endsWith(" refs/stash"))) return "it has Git stashes";
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  const tips = new Set([head.stdout.trim(), ...lines.map((line) => line.split(" ", 1)[0])]);
  for (const tip of tips) {
    if (!oid.test(tip)) return "could not read its Git refs";
    if (oid.test(mergedHead ?? "") && git(t.cwd, ["merge-base", "--is-ancestor", tip, mergedHead]).ok) continue;
    const found = git(t.repo, ["for-each-ref", "--count=1", `--contains=${tip}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
    if (!found.ok || !found.stdout.trim()) return `Git ref ${tip.slice(0, 12)} is not confirmed outside the OVNFS checkout`;
  }
  if (t.resolved_reason === "reviewed PR merged") {
    const start = t.branch_start;
    if (start?.name !== t.branch || !oid.test(start?.oid ?? "")) return "its original branch and starting commit could not be verified";
    if (!lines.includes(`${start.oid} refs/heads/${start.name}`)) return `branch ${start.name} has its own commits or moved since creation`;
  }
  return "";
}

export async function remove(t) {
  command(["rm", t.ovnfs_name, "--sticky-snapshots"]);
  // macOS NFS can cache the mount path after OVNFS drops the registration.
  if (!lookup(t)) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !pathGone(t.cwd)) await delay(250);
  }
  if (mounted(t)) throw new Error("checkout still registered after ovnfs rm");
}
