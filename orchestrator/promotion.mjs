import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

export const benchmarkMetric = "useful-build-v2";
export const scenarios = ["cold", "hot", "dirty-derive"];
export const realCases = ["mount", "capture-and-cache", "experiment-and-derived", "restart", "retention", "explicit-delete", "teardown"];
const backends = ["git-worktree", "ovnfs"];
const orders = [backends, backends.toReversed()];
const metrics = {
  first_use_ms: (run) => run.first_use_ms,
  total_ms: (run) => run.total_ms,
  retained_allocated_bytes: (run) => run.retained?.allocated_bytes,
};
const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const digest = (value) => matches(value, /^[a-f0-9]{64}$/);
const commit = (value) => matches(value, /^[a-f0-9]{40}$/);
const buildCounts = { cold: 1, hot: 3, "dirty-derive": 2 };
export function suiteManifest() {
  const root = new URL("../test/", import.meta.url);
  return Object.fromEntries(readdirSync(root).filter((name) => name.endsWith(".test.mjs")).sort().map((name) =>
    [`test/${name}`, createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex")]));
}

const identityKeys = ["revision", "candidate", "baseline", "workload"];
const sameRun = (a, b) => object(a) && object(b) && identityKeys.every((key) => typeof a[key] === "string" && a[key] === b[key]);
// Reviewed unfiltered Node 26 inventory; Node can report zero skips under --test-name-pattern.
const fullSuite = {
  "test/cleanup.test.mjs": [101, "74c5479a5c5c7677f5dc664f56c07e4e8d4b356aa69cfaa2acde0aea758e68db"],
  "test/cli.test.mjs": [11, "8bb9f28af3cf39444ad7f4f24cb80a543b9b4da656a15b7da3b7af1795659455"],
  "test/logic.test.mjs": [19, "571fd0496806d9900a54254f0a06e93a50529b145e8d9bfc03b8f347147022bf"],
  "test/ovnfs-tooling.test.mjs": [4, "6b389acab042826009ab017e708a250892e9215c62ed06770d56616645bda6ed"],
};
function completeSuite(regression, revision) {
  const files = regression?.files;
  if (regression?.status !== "passed" || !object(files) || Object.keys(files).length !== Object.keys(fullSuite).length) return false;
  try {
    const manifest = suiteManifest();
    if (Object.keys(manifest).length !== Object.keys(fullSuite).length) return false;
    let total = 0;
    for (const [name, [pass, hash]] of Object.entries(fullSuite)) {
      if (manifest[name] !== hash || files[name]?.sha256 !== hash || files[name].pass !== pass) return false;
      total += pass;
    }
    if (regression.tests !== total || regression.pass !== total || ["fail", "skipped", "cancelled", "todo"].some((key) => regression[key] !== 0)) return false;
    const cwd = new URL("../", import.meta.url);
    const git = (...args) => execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (git("rev-parse", "--verify", "HEAD").trim() !== revision) return false;
    const paths = ["orchestrator/promotion.mjs", ...Object.keys(fullSuite)];
    const tree = new Set(git("ls-tree", "-z", "--full-tree", revision, "--", ...paths).split("\0"));
    return paths.every((name) => {
      const bytes = readFileSync(new URL(name, cwd));
      const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      return tree.has(`100644 blob ${blob}\t${name}`) || tree.has(`100755 blob ${blob}\t${name}`);
    });
  } catch { return false; }
}

function validTiming(run, scenario) {
  const ovnfs = run.backend === "ovnfs";
  const cycle = (launch, build = launch) => [`${launch} launch preflight`, `${launch} launch`, `${build} build`, `${build} build verification`];
  const body = {
    cold: cycle("cold"),
    hot: ["cache seed preparation", ...cycle("reuse 1"), ...cycle("reuse 2"), "invalidate seed", ...cycle("invalidated", "invalidated cold")],
    "dirty-derive": ["parent launch preflight", "parent launch", "identical tracked edit", ...(ovnfs ? ["freeze dirty input preflight"] : []),
      "freeze dirty input", ...cycle("derive 1"), ...cycle("derive 2")],
  }[scenario];
  const names = ["fixture setup", "baseline storage preflight", ...(ovnfs ? ["daemon startup"] : []), ...body, "normal resolution and cleanup", "fixture teardown"];
  const { steps, first_use_ms: first, total_ms: total, inclusive_total_ms: inclusive, startup_ms: startup } = run;
  if (!Array.isArray(steps) || steps.length !== names.length || !names.every((name, i) =>
    steps[i]?.name === name && Number.isFinite(steps[i].ms) && steps[i].ms >= 0) || !positive(inclusive)) return false;

  // Stage times are lower bounds: the wall clock also includes bookkeeping between probes.
  const covers = (elapsed, stages) => elapsed + 1e-6 >= stages;
  const firstBuild = names.findIndex((name) => name.endsWith(" build"));
  let before = 0, after = 0, excluded = 0;
  for (let i = 2; i < steps.length - 2; i++) {
    const { name, ms } = steps[i];
    if (/(preflight|verification)$/.test(name)) excluded += ms;
    else if (i <= firstBuild) before += ms;
    else after += ms;
  }
  return (ovnfs ? positive(startup) && covers(steps[2].ms, startup) : startup === undefined) &&
    inclusive >= total &&
    covers(first, before) && covers(total - first, after) && covers(inclusive - total, excluded);
}

function load(path) {
  if (!path) return { status: "missing" };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.schema === 2) return { status: "present", data };
  } catch { /* unreadable input cannot supply evidence */ }
  return { status: "invalid" };
}

export function promotion(evidencePath, thresholdsPath) {
  const evidence = load(evidencePath), thresholds = load(thresholdsPath);
  const { environment, provenance, reliability, measurements, regression } = evidence.data ?? {};
  const host = environment?.ovnfs;
  const real = environment?.platform === "darwin" && ["arm64", "x64"].includes(environment.arch) &&
    matches(environment.macos, /^\d+(?:\.\d+){1,2}$/) && matches(environment.git, /^git version \d+\.\d+\.\d+/) &&
    matches(environment.volume, /^[a-z0-9_-]+$/i) && environment.node === "v26.13.1" &&
    host?.version === "v0.8.0" && host.os === environment.platform && host.arch === environment.arch && matches(host.go, /^go\d+\.\d+/) &&
    matches(provenance?.candidate, /^ovnfs\/v0\.8\.0\/[a-f0-9]{64}$/) && provenance.candidate === `ovnfs/${host.version}/${host.sha256}` &&
    commit(provenance.revision) && commit(provenance.baseline) && digest(provenance.workload);
  const cases = reliability?.cases;
  const reliabilityStatus = evidence.status !== "present" ? evidence.status
    : !real || !sameRun(reliability?.provenance, provenance) || !sameRun(regression?.provenance, provenance) ||
      cases?.["capture-and-cache"]?.baseline !== provenance.baseline || realCases.some((id) => cases?.[id]?.status === "failed") || regression?.status === "failed" ? "failed"
    : completeSuite(regression, provenance.revision) && realCases.every((id) => cases?.[id]?.status === "passed") ? "passed" : "missing";

  const limits = thresholds.data?.limits;
  const configured = typeof thresholds.data?.approval === "string" && thresholds.data.approval.trim() &&
    real && thresholds.data.metric === benchmarkMetric && sameRun(thresholds.data.provenance, provenance) &&
    scenarios.every((id) => object(limits?.[id]) && Object.keys(limits[id]).length && Object.entries(limits[id]).every(([name, max]) => Object.hasOwn(metrics, name) && positive(max))) &&
    scenarios.some((id) => Object.values(limits[id]).some((max) => max < 1));
  const thresholdStatus = thresholds.status === "present" ? configured ? "configured" : "invalid" : thresholds.status;

  let benefit = evidence.status === "present" ? "missing" : evidence.status;
  if (object(measurements)) {
    const trials = measurements.trials;
    const series = Object.fromEntries(scenarios.map((id) => [id, Array.isArray(trials?.[id]) ? trials[id] : []]));
    if (measurements.metric !== benchmarkMetric) benefit = "invalid";
    else if (!real || !sameRun(measurements.provenance, provenance) || scenarios.some((id) => series[id].some((pair) => Array.isArray(pair) && pair.some((r) => r?.status === "failed")))) benefit = "failed";
    else if (scenarios.every((id) => series[id].length === orders.length && orders.every((order, i) =>
      Array.isArray(series[id][i]) && series[id][i].length === order.length && order.every((backend, j) => {
        const run = series[id][i][j];
        return run?.backend === backend && run.status === "passed" && run.cleanup === "removed" && Object.values(metrics).every((metric) => positive(metric(run))) &&
          run.total_ms >= run.first_use_ms && commit(run.baseline) && Array.isArray(run.digests) && run.digests.length === buildCounts[id] && run.digests.every(digest);
      })))) {
      const matched = scenarios.every((id) => {
        const runs = series[id].flat();
        return runs.every((r) => r.baseline === provenance.baseline && r.digests.every((value, i) => value === runs[0].digests[i]));
      });
      const timing = scenarios.every((id) => series[id].flat().every((run) => validTiming(run, id)));
      benefit = !timing ? "invalid" : !matched ? "failed" : !configured ? "measured" : scenarios.every((id) => series[id].every((pair) => {
        const [git, ovnfs] = pair.toSorted((a, b) => a.backend.localeCompare(b.backend));
        return Object.entries(limits[id]).every(([name, max]) => metrics[name](ovnfs) / metrics[name](git) <= max);
      })) ? "passed" : "failed";
    }
  }
  return { default_backend: "git-worktree", promotion: reliabilityStatus === "passed" && benefit === "passed" && thresholdStatus === "configured" ? "eligible" : "blocked",
    reliability: reliabilityStatus, measured_benefit: benefit, thresholds: thresholdStatus };
}
