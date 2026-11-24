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
function completeSuite(regression) {
  let manifest;
  try { manifest = suiteManifest(); } catch { return false; }
  const files = regression?.files;
  if (regression?.status !== "passed" || !object(files) || !Object.keys(manifest).length || Object.keys(files).length !== Object.keys(manifest).length) return false;
  let total = 0;
  for (const [name, hash] of Object.entries(manifest)) {
    const file = files[name];
    if (file?.sha256 !== hash || !Number.isSafeInteger(file.pass) || file.pass < 1) return false;
    total += file.pass;
  }
  return regression.tests === total && regression.pass === total && regression.fail === 0 && regression.skipped === 0 && regression.cancelled === 0 && regression.todo === 0;
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
    : completeSuite(regression) && realCases.every((id) => cases?.[id]?.status === "passed") ? "passed" : "missing";

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
      benefit = !matched ? "failed" : !configured ? "measured" : scenarios.every((id) => series[id].every((pair) => {
        const [git, ovnfs] = pair.toSorted((a, b) => a.backend.localeCompare(b.backend));
        return Object.entries(limits[id]).every(([name, max]) => metrics[name](ovnfs) / metrics[name](git) <= max);
      })) ? "passed" : "failed";
    }
  }
  return { default_backend: "git-worktree", promotion: reliabilityStatus === "passed" && benefit === "passed" && thresholdStatus === "configured" ? "eligible" : "blocked",
    reliability: reliabilityStatus, measured_benefit: benefit, thresholds: thresholdStatus };
}
