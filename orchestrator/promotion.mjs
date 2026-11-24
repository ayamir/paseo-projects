import { readFileSync } from "node:fs";

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
function load(path) {
  if (!path) return { status: "missing" };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data?.schema === 1) return { status: "present", data };
  } catch { /* unreadable input cannot supply evidence */ }
  return { status: "invalid" };
}

export function promotion(evidencePath, thresholdsPath) {
  const evidence = load(evidencePath), thresholds = load(thresholdsPath);
  const { environment, reliability: cases, measurements, regression } = evidence.data ?? {};
  const candidate = environment?.candidate;
  const real = environment?.platform === "darwin" && matches(candidate, /^ovnfs\/v0\.8\.0\/[a-f0-9]{64}$/) &&
    commit(environment.integration) && digest(environment.workload) && environment.node === "v26.13.1";
  const regressionPassed = regression?.status === "passed" && Number.isSafeInteger(regression.tests) && regression.tests > 0 &&
    regression.pass === regression.tests && regression.fail === 0 && regression.skipped === 0;
  const reliability = evidence.status !== "present" ? evidence.status
    : !real || realCases.some((id) => cases?.[id]?.status === "failed") || regression?.status === "failed" ? "failed"
    : regressionPassed && realCases.every((id) => cases?.[id]?.status === "passed") ? "passed" : "missing";

  const limits = thresholds.data?.limits;
  const configured = typeof thresholds.data?.approval === "string" && thresholds.data.approval.trim() &&
    typeof candidate === "string" && thresholds.data.candidate === candidate && thresholds.data.workload === environment.workload &&
    scenarios.every((id) => object(limits?.[id]) && Object.keys(limits[id]).length && Object.entries(limits[id]).every(([name, max]) => Object.hasOwn(metrics, name) && positive(max))) &&
    scenarios.some((id) => Object.values(limits[id]).some((max) => max < 1));
  const thresholdStatus = thresholds.status === "present" ? configured ? "configured" : "invalid" : thresholds.status;

  let benefit = evidence.status === "present" ? "missing" : evidence.status;
  if (object(measurements)) {
    const series = Object.fromEntries(scenarios.map((id) => [id, Array.isArray(measurements[id]) ? measurements[id] : []]));
    if (scenarios.some((id) => series[id].some((pair) => Array.isArray(pair) && pair.some((r) => r?.status === "failed")))) benefit = "failed";
    else if (real && scenarios.every((id) => series[id].length === orders.length && orders.every((order, i) =>
      Array.isArray(series[id][i]) && series[id][i].length === order.length && order.every((backend, j) => {
        const run = series[id][i][j];
        return run?.backend === backend && run.status === "passed" && run.cleanup === "removed" && Object.values(metrics).every((metric) => positive(metric(run))) &&
          run.total_ms >= run.first_use_ms && commit(run.baseline) && Array.isArray(run.digests) && run.digests.length === buildCounts[id] && run.digests.every(digest);
      })))) {
      const matched = scenarios.every((id) => {
        const runs = series[id].flat();
        return runs.every((r) => r.baseline === runs[0].baseline && r.digests.every((value, i) => value === runs[0].digests[i]));
      });
      benefit = !matched ? "failed" : !configured ? "measured" : scenarios.every((id) => series[id].every((pair) => {
        const [git, ovnfs] = pair.toSorted((a, b) => a.backend.localeCompare(b.backend));
        return Object.entries(limits[id]).every(([name, max]) => metrics[name](ovnfs) / metrics[name](git) <= max);
      })) ? "passed" : "failed";
    }
  }
  return { default_backend: "git-worktree", promotion: reliability === "passed" && benefit === "passed" && thresholdStatus === "configured" ? "eligible" : "blocked",
    reliability, measured_benefit: benefit, thresholds: thresholdStatus };
}
