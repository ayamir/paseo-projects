import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";

const scope = new AsyncLocalStorage();
const flock = `use Fcntl qw(:flock);
open(my $lock, '+<&=3') or die "open lock: $!";
if (!flock($lock, LOCK_EX | LOCK_NB)) {
  exit 42 if $!{EWOULDBLOCK} || $!{EAGAIN};
  die "flock: $!";
}`;

export class LifecycleBusy extends Error {
  constructor() { super("working-copy lifecycle is busy; retry shortly"); }
}

// The kernel releases this lock only after PP and any in-flight backend child close it.
export function lifecycleStdio() {
  const fd = scope.getStore()?.fd;
  return fd === undefined ? undefined : ["pipe", "pipe", "pipe", fd];
}

export function withLifecycleLock(project, fn) {
  const path = join(realpathSync(project.root), ".working-copy.lock");
  if (scope.getStore()?.path === path && scope.getStore().fd !== undefined) return fn();
  const { O_CREAT, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = constants;
  const fd = openSync(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK, 0o600);
  const held = { path, fd };
  const close = () => { held.fd = undefined; closeSync(fd); };
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("working-copy lifecycle lock is not a regular, single-link file");
    const r = spawnSync("/usr/bin/perl", ["-e", flock], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", timeout: 5000 });
    if (r.status === 42) throw new LifecycleBusy();
    if (r.status !== 0) throw new Error(`could not lock working-copy lifecycle: ${r.error?.message ?? r.stderr}`);
    const result = scope.run(held, fn);
    if (result instanceof Promise) return result.finally(close);
    close();
    return result;
  } catch (e) {
    if (held.fd !== undefined) close();
    throw e;
  }
}
