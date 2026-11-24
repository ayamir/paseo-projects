// Opt-in: run only on a Mac where the caller can mount and ordinarily unmount local NFS.
import { readFileSync } from "node:fs";
import { scenarios } from "../orchestrator/promotion.mjs";
import { accept, workload } from "./ovnfs-acceptance.mjs";
import { checkout, fixture, requireThat as check, sha256, tools } from "./ovnfs-fixture.mjs";
import { measure } from "./ovnfs-measure.mjs";

async function main() {
  check(process.argv.length === 4 && process.platform === "darwin" && process.version === "v26.13.1", "usage on macOS, Node v26.13.1: node scripts/check-ovnfs.mjs /absolute/ovnfs /absolute/git");
  const binaries = tools(...process.argv.slice(2));
  const f = fixture(binaries);
  const evidence = { schema: 1, environment: { platform: process.platform, arch: process.arch, node: process.version, workload, unique_physical_bytes: "unknown" }, measurements: {} };
  try {
    const { environment: env } = evidence;
    env.integration = await f.git(checkout, "rev-parse", "HEAD");
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
    env.candidate = `ovnfs/${env.ovnfs.version}/${sha256(readFileSync(binaries.ovnfs))}`;
    env.background_load = "shared host; trials sequential; OS caches not purged";
  } catch (e) {
    await f.cleanup();
    throw new Error(f.scrub(e.message));
  }
  evidence.reliability = await accept(f);
  if (evidence.reliability.teardown.status !== "passed") console.error(`Fixture retained; inspect locally: ${f.dir}`);
  const realMountProven = evidence.reliability.mount.status === "passed" && evidence.reliability.teardown.status === "passed";
  let safe = evidence.reliability.teardown.status === "passed";
  for (const scenario of scenarios) {
    const pairs = evidence.measurements[scenario] = [];
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
    const result = await regressions.tests();
    const counts = Object.fromEntries([...result.stdout.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)].map(([, name, n]) => [name, Number(n)]));
    evidence.regression = { status: result.ok && counts.tests === counts.pass ? "passed" : "failed", ...counts };
    if (evidence.regression.status === "failed") {
      evidence.regression.failures = result.stdout.split("\n").filter((s) => s.startsWith("✖ ")).slice(0, 12);
      if (!result.ok && result.error) evidence.regression.exit = result.error;
    }
    try { await regressions.cleanup(); }
    catch (e) {
      evidence.regression.status = "failed";
      evidence.regression.cleanup_error = regressions.scrub(e.message);
      console.error(`Fixture retained; inspect locally: ${regressions.dir}`);
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (!Object.values(evidence.reliability).every((r) => r.status === "passed") || evidence.regression?.status !== "passed" ||
      Object.values(evidence.measurements).some((pairs) => pairs.flat().some((r) => r.status !== "passed"))) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
