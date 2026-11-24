import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { realCases } from "../orchestrator/promotion.mjs";
import { requireThat as check, sha256 } from "./ovnfs-fixture.mjs";

const cacheLine = "synthetic dependency bytes\n";
const cache = cacheLine.repeat(4096);
const clean = "clean\n";
export const dirty = "same dirty input on both backends\n";
const lock = "fixture lock v1\n";
const payload = Array.from({ length: 96 }, (_, i) => `${i}: synthetic input\n`.repeat(512));
export const workload = sha256(JSON.stringify({ cache, clean, dirty, lock, payload, children: 2 }));
export function file(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
export async function initialize(f) {
  await f.git(f.repo, "init", "-qb", "main");
  file(join(f.repo, ".gitignore"), "node_modules/\n");
  file(join(f.repo, "input.txt"), clean);
  file(join(f.repo, "lock.txt"), lock);
  for (const [i, data] of payload.entries()) file(join(f.repo, "input", `${i}.txt`), data);
  await f.git(f.repo, "add", ".");
  await f.git(f.repo, "commit", "-qm", "synthetic baseline");
  await f.cli("new", "fixture", "--repo", f.repo, "--thread-profile", "fixture");
  await f.cli("set", "fixture", "mute", "true");
  await f.startPaseo();
  return f.git(f.repo, "rev-parse", "HEAD");
}

export function warm(f, baseline) {
  file(join(f.repo, "node_modules", "allowed"), cache);
  file(join(f.project, "working-copy-cache.json"), JSON.stringify({ [f.repo]: {
    baseline, root: "node_modules", inputs: { "lock.txt": sha256(lock) }, files: { allowed: sha256(cache) },
  } }));
}

// Mount I/O is done by timed child commands, never while the service is stopped.
export const read = (f, path) => f.node("read fixture file", ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", path], 5000);
export const write = (f, path, value) => f.node("write fixture file", ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, value], 5000);
export const absent = async (f, path) => (await f.node("inspect fixture path", ["-e", `try { require('node:fs').lstatSync(process.argv[1]); console.log('present'); } catch (e) { if (e.code !== 'ENOENT') throw e; console.log('absent'); }`, path], 5000)) === "absent";

export async function launch(f, backend, ...args) {
  if (backend === "ovnfs") await f.proveMount();
  return dispatch(f, backend, ...args);
}

export async function dispatch(f, backend, ...args) {
  const output = await f.cli("thread", "start", "fixture", "--kind", backend === "ovnfs" ? "ovnfs" : "worktree", "--repo", f.repo, "--title", "Synthetic task", "--task", "Offline synthetic build", ...args);
  const match = output.match(/^started (t-\d+) .* agent (\S+)$/m);
  check(match, "PP did not report a started thread and Agent");
  const agent = f.agents().find((a) => a.id === match[2]);
  check(agent && agent.cwd !== f.repo && agent.cwd.startsWith(`${f.dir}/`), "fake Paseo did not receive a fixture checkout cwd");
  return { id: match[1], agent };
}

async function checkoutIdentity(f, w) {
  const { checkouts } = await f.registry();
  const row = checkouts.find((r) => r.name === w.identity.name);
  check(w.path.startsWith(`${f.mount}/`) && row?.path === w.path && row.git === true, "PP did not register an owned real mounted checkout");
  const privateGit = await f.git(w.path, "rev-parse", "--absolute-git-dir");
  check(privateGit === w.identity.git_dir && privateGit.startsWith(`${f.state}/`), "checkout did not use verified private Git metadata");
  return row;
}

const review = "https://github.com/fixture/fixture/pull/1";
const unavailable = /OVNFS.*(?:unreachable|not mounted)|ENOENT:.*admin\.sock/i;
const deleteArgs = (id, ...args) => ["thread", "delete-checkout", "fixture", id, ...args];
async function fails(f, reason, ...args) {
  const r = await f.attempt(...args);
  const raw = `${r.stdout}\n${r.stderr}`.trim();
  check(!r.ok && reason.test(raw), f.scrub(`expected visible refusal (${reason}), got: ${raw || r.error}`));
  return f.scrub(raw.split("\n").find((line) => reason.test(line)));
}

export async function accept(f) {
  const results = Object.fromEntries(realCases.map((name) => [name, { status: "not-run" }]));
  const run = async (name, fn) => {
    try { results[name] = { status: "passed", ...await fn() }; return true; }
    catch (e) { results[name] = { status: "failed", reason: f.scrub(e.message) }; return false; }
  };
  let baseline, main, experiment, snapshot, child, victim, beforeDelete;
  if (await run("mount", async () => {
    baseline = await initialize(f);
    return { startup_ms: await f.startOvnfs(), transport: "NFSv3 Unix socket" };
  })) {
    await run("capture-and-cache", async () => {
      warm(f, baseline);
      file(join(f.repo, "untracked.txt"), "nonignored untracked input\n");
      file(join(f.repo, "input.txt"), dirty);
      const { id, agent } = await launch(f, "ovnfs", "--reviews", review);
      main = await f.show(id);
      const w = main.working_copy;
      const registry = await checkoutIdentity(f, w);
      check(agent.cwd === w.path && w.baseline === baseline && registry.source === f.repo, "native checkout source identity mismatch");
      check(!w.ovnfs.capture && !w.cache && await absent(f, join(f.root, ".pp-working-copy-inputs")), "PP staged an intermediate input for native OVNFS");
      check(await f.git(w.path, "rev-parse", "HEAD") === baseline, "checkout baseline differs from committed source");
      check(await read(f, join(w.path, "input.txt")) === clean.trim() && await absent(f, join(w.path, "untracked.txt")), "native revision inherited tracked edits or nonignored untracked files");
      check(await read(f, join(w.path, "node_modules", "allowed")) === cache.trim(), "native checkout did not reuse ignored build state");
      await write(f, join(w.path, "node_modules", "allowed"), "isolated cache edit\n");
      check(readFileSync(join(f.repo, "node_modules", "allowed"), "utf8") === cache && readFileSync(join(f.repo, "input.txt"), "utf8") === dirty, "checkout wrote back to the source");
      return { baseline, registry_source_is_original: true };
    });
    if (main?.working_copy?.phase === "ready") {
      await run("experiment-and-derived", async () => {
        await f.proveMount();
        await f.cli("thread", "experiment", "fixture", main.id, "--name", "scratch");
        experiment = (await f.show(main.id)).working_copies.find((w) => w.resource === "scratch");
        await checkoutIdentity(f, experiment);
        check(experiment.identity.git_dir !== main.working_copy.identity.git_dir && await f.git(experiment.path, "rev-parse", "HEAD") === baseline, "experiment Git state shares identity or has incorrect baseline");
        await f.git(experiment.path, "commit", "--allow-empty", "-qm", "experiment commit");
        const experimentHead = await f.git(experiment.path, "rev-parse", "HEAD");
        await write(f, join(experiment.path, "input.txt"), "frozen edit\n");
        await f.proveMount();
        await f.cli("thread", "snapshot", "fixture", main.id, "--name", "save", "--resource", "scratch");
        snapshot = (await f.show(main.id)).working_copies.find((w) => w.resource === "save");
        check(snapshot.depends_on[0] === experiment.nonce && (await f.registry()).snapshots.some((s) => s.id === snapshot.identity.id), "owning snapshot reference not registered");
        let launchResult;
        try { launchResult = await launch(f, "ovnfs", "--from-snapshot", `${main.id}/save`); }
        catch (e) {
          const row = (await f.registry()).checkouts.find((c) => c.parent === snapshot.identity.id);
          if (!row || !e.message.includes("checkout generation does not match")) throw e;
          const gitDir = await f.git(row.path, "rev-parse", "--absolute-git-dir");
          check(gitDir.startsWith(`${f.state}/git/`), "unverified derivative Git directory");
          const marker = readFileSync(join(gitDir, "pp-working-copy"), "utf8").split("\n")[0];
          throw new Error(`${e.message}; derivative registry row exists; generation marker belongs to ${marker === experiment.nonce ? "the snapshot source" : "another resource"}`);
        }
        child = await f.show(launchResult.id);
        const w = child.working_copy, row = await checkoutIdentity(f, w);
        check(launchResult.agent.cwd === w.path && w.owner === child.id && w.depends_on[0] === snapshot.nonce && row.parent === snapshot.identity.id, "cross-thread derivative lost snapshot lineage or cwd");
        check(w.identity.git_dir !== experiment.identity.git_dir && w.identity.initial_oid === experimentHead &&
          await f.git(w.path, "rev-parse", "HEAD") === experimentHead, "derived checkout lost the snapshot's private Git commit");
        check(await read(f, join(w.identity.git_dir, "pp-working-copy")) === `${w.nonce}\n${experimentHead}` &&
          await read(f, join(experiment.identity.git_dir, "pp-working-copy")) === `${experiment.nonce}\n${baseline}`, "derivation changed the source generation or failed to register a child generation");
        check(await read(f, join(w.path, "input.txt")) === "frozen edit", "snapshot did not freeze the edited bytes");
        await write(f, join(w.path, "input.txt"), "child only\n");
        check(await read(f, join(experiment.path, "input.txt")) === "frozen edit" && await read(f, join(main.cwd, "input.txt")) === clean.trim() &&
          readFileSync(join(f.repo, "input.txt"), "utf8") === dirty, "derived write changed its parent, sibling or source");
      });
      if (f.mounted) await run("retention", async () => {
        await f.proveMount();
        const registry = await f.registry();
        await write(f, join(main.thread_dir, "report.md"), "## Report\nfixture complete\n");
        await f.cli("report", "--thread", `fixture/${main.id}`, "--percent", "100");
        for (let i = 0; i < 2; i++) await f.runTicker();
        check((await f.show(main.id)).resolved_reason === "reviewed PR merged", "ticker did not automatically resolve the simulated merged review");
        const cleanup = await f.cli("thread", "cleanup", "fixture", main.id);
        await f.cli("sweep", "fixture", "--yes");
        const after = await f.show(main.id);
        const mainNote = cleanup.split(/; (?=OVNFS \S+ kept:)/).find((note) => note.includes("OVNFS main kept:"));
        check(after.working_copy.disposal.phase === "retained" && mainNote?.includes("checkout deletion is explicit-only"), `automatic resolution/cleanup/sweep did not report retention: ${cleanup}`);
        check(sameRegistry(registry, await f.registry()), "automatic resolution/cleanup/sweep lost a resource");
        if (snapshot) {
          await fails(f, /snapshots are not deletable/, ...deleteArgs(main.id, "--resource", "save"));
          await fails(f, /depends on this checkout|depends on this worktree/, ...deleteArgs(main.id, "--resource", "scratch"));
          check(sameRegistry(registry, await f.registry()), "dependency refusal altered the registry");
        }
      });
      await run("restart", async () => {
        const { id } = await launch(f, "ovnfs");
        await f.cli("thread", "resolve", "fixture", id);
        await f.cli("thread", "resolve", "fixture", id, "--reopen");
        const registry = await f.registry(), w = (await f.show(id)).working_copy, numberAgents = f.agents().length;
        const row = await checkoutIdentity(f, w);
        await f.stopOvnfs();
        let outage, startup_ms;
        try {
          outage = await fails(f, unavailable, "thread", "restart", "fixture", id, "--fresh");
          check(f.agents().length === numberAgents && (await f.show(id)).working_copy.nonce === w.nonce, "offline restart created an Agent or changed the registered resource");
        } finally {
          startup_ms = await f.startOvnfs();
        }
        await f.proveMount();
        check(sameRegistry(registry, await f.registry()), "daemon restart added or removed registered resources");
        const remounted = await checkoutIdentity(f, w);
        check(["created", "source", "base", "parent"].every((key) => row[key] === remounted[key]), "remount changed the checkout registration");
        const stat = await f.node("read fixture directory identity", ["-e", `
          const s = require('node:fs').lstatSync(process.argv[1], { bigint: true });
          console.log(s.dev + ':' + s.ino);
        `, w.path], 5000);
        const [device, inode] = stat.split(":");
        const [oldDevice, oldInode] = w.identity.directory.split(":");
        check(inode === oldInode, "remount changed the checkout inode");
        try { await f.cli("thread", "restart", "fixture", id, "--fresh"); }
        catch (e) {
          if (!e.message.includes("checkout identity does not match")) throw e;
          check(f.agents().length === numberAgents && (await f.show(id)).working_copy.nonce === w.nonce, "rejected restart changed the registered resource or created an Agent");
          throw new Error(`${e.message}; NFS device ${device === oldDevice ? "unchanged" : "changed"}, inode unchanged; no duplicate checkout or Agent`);
        }
        const after = await f.show(id);
        check(after.cwd === w.path && after.working_copy.nonce === w.nonce && f.agents().length === numberAgents + 1 && f.agents().at(-1)?.cwd === w.path, "restart changed identity or fake Agent cwd");
        check(sameRegistry(registry, await f.registry()), "restart added or removed registered resources");
        check(device !== oldDevice, "ordinary remount kept the NFS device, so the restart after a device change was not exercised");
        return { outage, startup_ms, device_changed: true, inode_unchanged: inode === oldInode };
      });
    }
    if (f.mounted) await run("explicit-delete", async () => {
      // The test victim must have no undeclared cache files to discard.
      rmSync(join(f.repo, "node_modules", "allowed"), { force: true });
      rmdirSync(join(f.repo, "node_modules"));
      const { id: offlineVictim } = await launch(f, "ovnfs");
      await f.cli("thread", "resolve", "fixture", offlineVictim);
      const beforeOutage = await f.registry(), offline = (await f.show(offlineVictim)).working_copy;
      await f.stopOvnfs();
      try {
        await fails(f, unavailable, ...deleteArgs(offlineVictim));
        check((await f.show(offlineVictim)).working_copy.disposal.phase !== "removed", "offline removal was reported as complete");
      } finally {
        await f.startOvnfs();
      }
      check(sameRegistry(beforeOutage, await f.registry()), "blocked disposal altered the registry");
      await f.cli(...deleteArgs(offlineVictim));
      check((await f.show(offlineVictim)).working_copy.disposal.phase === "removed" && await absent(f, offline.path) &&
        await absent(f, offline.identity.git_dir) && sameRegistry({ ...beforeOutage, checkouts: beforeOutage.checkouts.filter((c) => c.name !== offline.identity.name) }, await f.registry()),
      "explicit deletion after remount did not remove exactly the same checkout");
      // The second checkout tests preservation of a commit and a declared file.
      ({ id: victim } = await launch(f, "ovnfs"));
      const { working_copy: w, thread_dir } = await f.show(victim);
      await checkoutIdentity(f, w);
      const output = join(thread_dir, "library", "result.txt");
      await write(f, output, "recoverable synthetic result\n");
      await f.git(w.path, "commit", "--allow-empty", "-qm", "private result");
      const tip = await f.git(w.path, "rev-parse", "HEAD");
      await write(f, join(thread_dir, "cleanup.json"), JSON.stringify({ commits: [tip] }));
      await fails(f, /not resolved/, ...deleteArgs(victim));
      await f.cli("thread", "resolve", "fixture", victim);
      beforeDelete = await f.registry();
      await f.occupy(w.path, (pid) => fails(f, new RegExp(`occupied by process ${pid}`), ...deleteArgs(victim)));
      await f.proveMount();
      const refs = await f.git(f.repo, "show-ref");
      await fails(f, /commit .* is not (present in|on a source branch)/, ...deleteArgs(victim));
      check((await f.show(victim)).working_copy.disposal.phase === "retained" && !await absent(f, w.path) &&
        sameRegistry(beforeDelete, await f.registry()) && await f.git(f.repo, "show-ref") === refs, "private-commit refusal did not preserve checkout and source refs");
      await f.git(f.repo, "fetch", "--no-tags", w.path, "HEAD:refs/remotes/origin/fixture-result");
      const published = await f.git(f.repo, "show-ref");
      await f.cli(...deleteArgs(victim));
      const { disposal } = (await f.show(victim)).working_copy;
      const afterDelete = await f.registry();
      check(disposal.phase === "removed" && await absent(f, w.path) && await absent(f, w.identity.git_dir) &&
        sameRegistry({ ...beforeDelete, checkouts: beforeDelete.checkouts.filter((c) => c.name !== w.identity.name) }, afterDelete) &&
        await f.git(f.repo, "show-ref") === published, "deletion did not remove exactly one checkout or changed the source refs");
      const evidence = disposal.evidence.path;
      check(evidence.startsWith(`${f.root}/`) && readFileSync(join(evidence, "files", relative(w.path, output)), "utf8") === "recoverable synthetic result\n", "archived file is not independently readable");
      const restored = join(f.dir, "restore.git");
      await f.git(f.dir, "clone", "--mirror", join(evidence, "commits.bundle"), restored);
      check(await f.git(restored, "rev-parse", `refs/heads/saved/${tip}`) === tip, "archived commit is not independently recoverable");
      await f.cli(...deleteArgs(victim));
      check(sameRegistry(afterDelete, await f.registry()), "rechecking explicit deletion changed the registry");
    });
  }
  await run("teardown", () => f.cleanup());
  return results;
}

function sameRegistry(a, b) {
  return JSON.stringify([a.checkouts.map((r) => r.name).sort(), a.snapshots.map((s) => s.id).sort()]) ===
    JSON.stringify([b.checkouts.map((r) => r.name).sort(), b.snapshots.map((s) => s.id).sort()]);
}

export const build = (f, cwd, { hot = false } = {}) => f.node("offline synthetic build", ["-e", `
    const { existsSync, readFileSync, readdirSync } = require('node:fs'), { join } = require('node:path');
    const path = process.argv[1], cachePath = join(path, 'node_modules/allowed');
    if (existsSync(cachePath) !== (process.argv[2] === 'hot')) throw new Error('cache state does not match trial');
    const h = require('node:crypto').createHash('sha256');
    h.update(readFileSync(join(path, 'input.txt'))); h.update(readFileSync(join(path, 'lock.txt')));
    for (const name of readdirSync(join(path, 'input')).sort()) h.update(readFileSync(join(path, 'input', name)));
    h.update(existsSync(cachePath) ? readFileSync(cachePath) : ${JSON.stringify(cacheLine)}.repeat(4096));
    console.log(h.digest('hex'));
  `, cwd, hot ? "hot" : "cold"], 20_000);

export function verifyBuild(digest, { edited = false } = {}) {
  const expected = sha256([edited ? dirty : clean, lock, ...Object.keys(payload).sort().map((i) => payload[i]), cache].join(""));
  check(digest === expected, "offline build output did not match the known synthetic inputs");
}
