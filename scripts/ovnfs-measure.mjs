import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { build, dirty, file, initialize, launch, warm, write } from "./ovnfs-acceptance.mjs";
import { requireThat as check } from "./ovnfs-fixture.mjs";

async function retained(f, backend) {
  const storage = { source: await f.size(f.repo), pp: await f.size(f.root), backend_state: await f.size(f.state) };
  const trees = readdirSync(f.dir).filter((name) => /^pp-t-\d+-/.test(name));
  storage.git_worktrees = { logical_bytes: 0, allocated_bytes: 0 };
  for (const path of trees) {
    const bytes = await f.size(join(f.dir, path));
    for (const k of Object.keys(bytes)) storage.git_worktrees[k] += bytes[k];
  }
  return {
    ...Object.fromEntries(Object.keys(storage.source).map((k) => [k, Object.values(storage).reduce((total, row) => total + row[k], 0)])),
    storage, git_worktrees: trees.length,
    ...(backend === "ovnfs" && f.mounted ? await f.registry().then((r) => ({ checkouts: r.checkouts.length, snapshots: r.snapshots.length })) : {}),
  };
}

export async function measure(f, backend, scenario) {
  const run = { backend, status: "failed", steps: [] };
  let stage = "fixture setup", base, at, storage;
  const timed = async (name, fn) => {
    stage = name;
    const start = performance.now();
    try { return await fn(); }
    finally { run.steps.push({ name, ms: performance.now() - start }); }
  };
  const captureRoot = join(f.root, ".pp-working-copy-inputs");
  const capturePaths = () => existsSync(captureRoot) ? readdirSync(captureRoot).filter((name) => existsSync(join(captureRoot, name, "repo"))) : [];
  const start = async (name, ...flags) => {
    const captures = new Set(capturePaths());
    let ready;
    if (backend === "ovnfs") await f.proveMount();
    const launchAt = performance.now();
    // The published capture is a local path. Polling bounds timing resolution, not the capture itself.
    const poll = setInterval(() => {
      if (capturePaths().some((path) => !captures.has(path))) ready ??= performance.now();
    }, 10);
    try {
      const result = await timed(name, () => launch(f, backend, ...flags));
      const step = run.steps.at(-1);
      if (ready !== undefined) step.to_capture_ready_ms = ready - launchAt;
      return result;
    } finally { clearInterval(poll); }
  };
  const useful = async (name, t, options = {}, expectedCache) => {
    const { digest } = await timed(name, () => build(f, t.agent.cwd, options));
    run.first_use_ms ??= performance.now() - at;
    (run.digests ??= []).push(digest);
    if (expectedCache) {
      const { working_copy: w } = await f.show(t.id);
      check(w.cache?.state === expectedCache && w.path === t.agent.cwd, `expected ${expectedCache} cache at the actual Agent cwd`);
    }
  };
  try {
    base = await timed("fixture setup", () => initialize(f));
    run.baseline = base;
    run.baseline_storage = await f.size(f.repo);
    at = performance.now();
    if (backend === "ovnfs") run.startup_ms = await timed("daemon startup", () => f.startOvnfs());
    if (scenario === "cold") {
      await useful("cold build", await start("cold launch"));
    } else if (scenario === "hot") {
      await timed("cache seed preparation", () => warm(f, base));
      for (let i = 1; i <= 2; i++) await useful(`reuse ${i} build`, await start(`reuse ${i} launch`), { hot: true }, "reused");
      await timed("invalidate seed", () => file(join(f.repo, "node_modules", "allowed"), "synthetic corrupt seed\n"));
      await useful("invalidated cold build", await start("invalidated launch"), {}, "cold");
    } else {
      const parent = await start("parent launch");
      await timed("identical tracked edit", () => write(f, join(parent.agent.cwd, "input.txt"), dirty));
      const flags = await timed("freeze dirty input", async () => {
        if (backend === "ovnfs") {
          await f.proveMount();
          await f.cli("thread", "snapshot", "fixture", parent.id, "--name", "dirty");
          return ["--from-snapshot", `${parent.id}/dirty`];
        }
        await f.git(parent.agent.cwd, "commit", "-qam", "equivalent tracked edit");
        return ["--base", await f.git(parent.agent.cwd, "rev-parse", "HEAD")];
      });
      for (let i = 1; i <= 2; i++) await useful(`derive ${i} build`, await start(`derive ${i} launch`, ...flags), { edited: true });
    }
    run.total_ms = performance.now() - at;
    run.status = "passed";
  } catch (e) {
    run.reason = f.scrub(`${stage}: ${e.message}`);
    if (at !== undefined) run.elapsed_to_failure_ms = performance.now() - at;
  }
  if (base && (backend === "git-worktree" || f.mounted)) {
    try {
      await timed("normal resolution and cleanup", async () => {
        if (backend === "ovnfs") await f.proveMount();
        const threads = JSON.parse(await f.cli("--json", "thread", "list", "fixture", "--all"));
        for (const row of threads) {
          await f.cli("thread", "resolve", "fixture", row.id);
          await f.cli("thread", "cleanup", "fixture", row.id);
        }
      });
    } catch (e) { run.status = "failed"; run.retention_error = f.scrub(e.message); }
  }
  try {
    storage = await retained(f, backend);
    run.retained = storage;
  } catch (e) { run.status = "failed"; run.storage_error = f.scrub(e.message); }
  try {
    await timed("fixture teardown", () => f.cleanup());
    run.cleanup = "removed";
  } catch (e) {
    run.status = "failed";
    run.cleanup = "retained";
    run.cleanup_error = f.scrub(e.message);
  }
  return run;
}
