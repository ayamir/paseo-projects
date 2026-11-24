// Opt-in: run only on a Mac where the caller can mount and ordinarily unmount local NFS.
import { readFileSync } from "node:fs";
import { benchmarkMetric, scenarios, suiteManifest } from "../orchestrator/promotion.mjs";
import { accept, workload } from "./ovnfs-acceptance.mjs";
import { checkout, fixture, requireThat as check, sha256, tools } from "./ovnfs-fixture.mjs";
import { measure } from "./ovnfs-measure.mjs";

async function main() {
  check(process.argv.length === 4 && process.platform === "darwin" && process.version === "v26.13.1", "usage on macOS, Node v26.13.1: node scripts/check-ovnfs.mjs /absolute/ovnfs /absolute/git");
  const binaries = tools(...process.argv.slice(2));
  const f = fixture(binaries);
  const environment = { platform: process.platform, arch: process.arch, node: process.version, unique_physical_bytes: "unknown" };
  const provenance = { workload };
  const evidence = { schema: 2, environment, provenance };
  const assertRevision = async () => {
    const revision = await f.git(checkout, "rev-parse", "HEAD");
    check(!provenance.revision || revision === provenance.revision, "tested revision changed during acceptance");
    const status = await f.git(checkout, "status", "--porcelain=v1", "--untracked-files=all");
    check(status.split("\n").every((line) => !line || line === "?? node_modules"), "acceptance requires a clean committed revision (except the local dependency symlink)");
    return revision;
  };
  try {
    const { environment: env } = evidence;
    provenance.revision = await assertRevision();
    env.git = await f.git(f.repo, "--version");
    env.macos = await f.checked("macOS version", "/usr/bin/sw_vers", ["-productVersion"]);
    const device = (await f.checked("fixture volume", "/bin/df", ["-P", f.dir])).split("\n").at(-1).split(/\s+/)[0];
    env.volume = await f.checked("fixture volume type", "/usr/sbin/diskutil", ["info", "-plist", device]).then(async (plist) => {
      const path = `${f.dir}/volume.plist`;
      // Supply the plist on disk rather than invoking a shell pipeline.
      await f.node("write synthetic volume metadata", ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, plist]);
      return f.checked("fixture filesystem type", "/usr/bin/plutil", ["-extract", "FilesystemType", "raw", path]);
    });
    env.ovnfs = JSON.parse(await f.version());
    env.ovnfs.sha256 = sha256(readFileSync(binaries.ovnfs));
    provenance.candidate = `ovnfs/${env.ovnfs.version}/${env.ovnfs.sha256}`;
    env.background_load = "shared host; trials sequential; OS caches not purged";
  } catch (e) {
    try { await f.cleanup(); }
    catch (cleanup) { console.error(`Fixture retained; inspect locally: ${f.dir}: ${f.scrub(cleanup.message)}`); }
    throw new Error(f.scrub(e.message));
  }
  const cases = await accept(f);
  provenance.baseline = cases["capture-and-cache"]?.baseline;
  evidence.reliability = { provenance, cases };
  const trials = {};
  evidence.measurements = { provenance, metric: benchmarkMetric, trials };
  if (cases.teardown.status !== "passed") console.error(`Fixture retained; inspect locally: ${f.dir}`);
  const realMountProven = cases.mount.status === "passed" && cases.teardown.status === "passed";
  let safe = cases.teardown.status === "passed";
  for (const scenario of scenarios) {
    const pairs = trials[scenario] = [];
    for (const order of [["git-worktree", "ovnfs"], ["ovnfs", "git-worktree"]]) {
      const pair = [];
      for (const backend of order) {
        if (!safe || (backend === "ovnfs" && !realMountProven)) {
          pair.push({ backend, status: "not-run", reason: "fixture mount or ordinary teardown was not proven" });
          continue;
        }
        const trial = fixture(binaries);
        const run = await measure(trial, backend, scenario);
        pair.push(run);
        if (run.cleanup !== "removed") {
          console.error(`Fixture retained; inspect locally: ${trial.dir}`);
          safe = false;
        }
      }
      pairs.push(pair);
    }
  }
  if (safe) {
    // No real OVNFS executable on the regression suite's PATH.
    const regressions = fixture({ git: binaries.git });
    const regression = evidence.regression = { provenance, status: "passed", files: {}, tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
    try {
      for (const [file, hash] of Object.entries(suiteManifest())) {
        const result = await regressions.tests([file.slice("test/".length)]);
        const counts = Object.fromEntries([...result.stdout.matchAll(/^ℹ (tests|pass|fail|skipped|cancelled|todo) (\d+)$/gm)].map(([, name, n]) => [name, Number(n)]));
        if (!result.ok || !counts.tests || counts.tests !== counts.pass || ["fail", "skipped", "cancelled", "todo"].some((name) => counts[name] !== 0)) {
          regression.status = "failed";
          regression.failed_file = file;
          break;
        }
        regression.files[file] = { sha256: hash, pass: counts.pass };
        for (const [name, n] of Object.entries(counts)) regression[name] += n;
      }
    } catch (e) {
      regression.status = "failed";
      regression.error = regressions.scrub(e.message);
    }
    try { await regressions.cleanup(); }
    catch (e) {
      evidence.regression.status = "failed";
      evidence.regression.cleanup_error = regressions.scrub(e.message);
      console.error(`Fixture retained; inspect locally: ${regressions.dir}`);
    }
  }
  await assertRevision();
  check(sha256(readFileSync(binaries.ovnfs)) === environment.ovnfs.sha256, "pinned candidate changed during acceptance");
  console.log(JSON.stringify(evidence, null, 2));
  if (!Object.values(cases).every((r) => r.status === "passed") || evidence.regression?.status !== "passed" ||
      Object.values(trials).some((pairs) => pairs.flat().some((r) => r.status !== "passed"))) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
