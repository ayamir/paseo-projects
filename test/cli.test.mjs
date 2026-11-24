// The command line's declarations (orchestrator/cli.mjs): every option a usage line shows is accepted for that
// command, and any other option is refused before the command runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES, HELP, VALUE_FLAGS, check, parse } from "../orchestrator/cli.mjs";
import { benchmarkMetric, suiteManifest } from "../orchestrator/promotion.mjs";

const PP = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pp.mjs");

// Every spelling of a command's words: `thread stop|ack` is two commands.
const spellings = (head) => head.reduce((all, alts) => all.flatMap((w) => alts.map((a) => [...w, a])), [[]]);
const argvOf = (words, flags) => [...words, "<arg>", ...Object.entries(flags).flatMap(([k, takes]) => takes ? [`--${k}`, "v"] : [`--${k}`])];
const run = (argv) => { const { pos, given, inlined } = parse(argv); check(pos, given, inlined); };

test("every option of every usage line is accepted for that command", () => {
  assert.ok(ENTRIES.length > 40);
  for (const e of ENTRIES) for (const words of spellings(e.head)) {
    assert.doesNotThrow(() => run(argvOf(words, e.flags)), `${words.join(" ")}: ${e.use}`);
  }
});

test("an option the command does not declare is refused, naming it and the usage, whichever the command", () => {
  for (const e of ENTRIES) for (const words of spellings(e.head)) {
    const argv = argvOf(words, e.flags);
    for (const bogus of ["--dry-run-typo", "--bogus=1"]) {
      assert.throws(() => run([...argv, bogus]), (err) => err.message.includes(`--${bogus.slice(2).split("=")[0]}`) && err.message.includes(`pp ${e.use}`), `${words.join(" ")} ${bogus}`);
    }
  }
});

test("an option of another command is refused too, `--dry-run` on resolve above all", () => {
  assert.throws(() => run(["thread", "resolve", "demo", "t-1", "--dry-run"]), /unknown option --dry-run for `pp thread resolve`[^]*thread resolve <slug> <id> \[--reopen\]/);
  assert.throws(() => run(["thread", "stop", "demo", "t-1", "--force"]), /unknown option --force/);
  assert.doesNotThrow(() => run(["thread", "cleanup", "demo", "t-1", "--dry-run"]));
  assert.throws(() => run(["--bogus"]), /unknown option --bogus/);
  assert.doesNotThrow(() => run(["--root", "/x", "help"]));
});

test("a switch given a value is refused, not read as on", () => {
  assert.throws(() => run(["thread", "resolve", "demo", "t-1", "--force=false"]), /--force takes no value/);
  // Every occurrence counts, not the last one: a later bare `--force` must not hide the first.
  assert.throws(() => run(["thread", "resolve", "demo", "t-1", "--force=false", "--force"]), /--force takes no value/);
  assert.throws(() => run(["thread", "resolve", "demo", "t-1", "--force", "--force=false"]), /--force takes no value/);
  assert.doesNotThrow(() => run(["thread", "start", "demo", "--title=T", "--task=x"]));
});

test("an unknown or incomplete command is refused with the usage lines of its name", () => {
  assert.throws(() => run(["nope"]), /unknown command `nope`/);
  assert.throws(() => run(["thread", "bogus", "demo"]), /unknown or incomplete command `pp thread bogus demo`[^]*thread resolve/);
  assert.throws(() => run(["thread"]), /unknown or incomplete command/);
  assert.throws(() => run(["profile"]), /unknown or incomplete command/);
});

test("help is the table: each usage line is in it, and an option names one meaning", () => {
  for (const e of ENTRIES) assert.ok(HELP.includes(e.use), e.use);
  assert.ok(VALUE_FLAGS.has("root") && VALUE_FLAGS.has("text-file") && !VALUE_FLAGS.has("dry-run") && !VALUE_FLAGS.has("fresh"));
});

test("promotion check blocks without evidence or approved thresholds", () => {
  const r = spawnSync(process.execPath, [PP, "working-copy", "promotion"], {
    encoding: "utf8", env: { PATH: process.env.PATH, PP_CONFIG: "/dev/null" },
  });
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), {
    default_backend: "git-worktree", promotion: "blocked", reliability: "missing", measured_benefit: "missing", thresholds: "missing",
  });
});

test("promotion checks reliability and every matched comparison independently without changing the default", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pp-promotion-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidencePath = join(dir, "evidence.json"), approvalPath = join(dir, "approval.json"), unusedRoot = join(dir, "untouched");
  const provenance = { revision: "b".repeat(40), baseline: "1".repeat(40), candidate: `ovnfs/v0.8.0/${"a".repeat(64)}`, workload: "c".repeat(64) };
  const files = Object.fromEntries(Object.entries(suiteManifest()).map(([name, sha256]) => [name, { sha256, pass: 2 }]));
  const count = 2 * Object.keys(files).length;
  const cases = Object.fromEntries(["mount", "capture-and-cache", "experiment-and-derived", "restart", "retention", "explicit-delete", "teardown"].map((key) => [key, { status: "passed" }]));
  cases["capture-and-cache"].baseline = provenance.baseline;
  const evidence = { schema: 2, provenance,
    environment: { platform: "darwin", arch: "arm64", node: "v26.13.1", macos: "27.2.1", git: "git version 2.56.1", volume: "apfs", ovnfs: { version: "v0.8.0", go: "go1.27.3", os: "darwin", arch: "arm64", sha256: "a".repeat(64) } },
    regression: { provenance, status: "passed", files, tests: count, pass: count, fail: 0, skipped: 0, cancelled: 0, todo: 0 },
    reliability: { provenance, cases },
    measurements: { provenance, metric: benchmarkMetric, trials: Object.fromEntries([["cold", 1], ["hot", 3], ["dirty-derive", 2]].map(([scenario, n]) => {
      const trial = (backend, ms) => ({ backend, status: "passed", cleanup: "removed", first_use_ms: ms, total_ms: ms, retained: { allocated_bytes: 100 }, baseline: provenance.baseline, digests: Array(n).fill("d".repeat(64)) });
      return [scenario, [[trial("git-worktree", 100), trial("ovnfs", 80)], [trial("ovnfs", 90), trial("git-worktree", 100)]]];
    })) } };
  const approval = { schema: 2, metric: benchmarkMetric, approval: "synthetic approval for this test only", provenance,
    limits: { cold: { first_use_ms: 0.9 }, hot: { total_ms: 0.9 }, "dirty-derive": { retained_allocated_bytes: 1 } } };
  function run(reliability, benefit, thresholds, status, { input = evidence, policy = approval } = {}) {
    writeFileSync(evidencePath, JSON.stringify(input));
    if (policy) writeFileSync(approvalPath, JSON.stringify(policy));
    const r = spawnSync(process.execPath, [PP, "--root", unusedRoot, "working-copy", "promotion", "--evidence", evidencePath, ...(policy ? ["--thresholds", approvalPath] : [])], {
      encoding: "utf8", env: { PATH: process.env.PATH, PP_CONFIG: "/dev/null" },
    });
    assert.equal(r.status, status, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { default_backend: "git-worktree", promotion: status === 0 ? "eligible" : "blocked", reliability, measured_benefit: benefit, thresholds });
    assert.ok(!existsSync(unusedRoot));
  }
  run("passed", "measured", "missing", 1, { policy: null });
  run("passed", "passed", "configured", 0);
  const broken = structuredClone(evidence);
  broken.measurements.trials.cold[1][0].digests[0] = "e".repeat(64);
  run("passed", "failed", "configured", 1, { input: broken });
  run("failed", "passed", "configured", 1, { input: { ...evidence, reliability: { provenance, cases: { ...cases, retention: { status: "failed" } } } } });
  run("passed", "failed", "configured", 1, { policy: { ...approval, limits: { ...approval.limits, cold: { first_use_ms: 0.85 } } } });
  run("passed", "measured", "invalid", 1, { policy: { ...approval, provenance: { ...provenance, candidate: "wrong binary" } } });
  run("passed", "measured", "invalid", 1, { policy: { ...approval, limits: {
    cold: { first_use_ms: 1 }, hot: { total_ms: 1 }, "dirty-derive": { retained_allocated_bytes: 1 },
  } } });
  const mutate = (change) => { const input = JSON.parse(JSON.stringify(evidence)); change(input); return { input }; };
  run("failed", "failed", "invalid", 1, mutate((input) => delete input.environment.macos));
  run("failed", "failed", "invalid", 1, mutate((input) => { input.environment.ovnfs.version = "v0.7.0"; }));
  run("missing", "passed", "configured", 1, mutate((input) => {
    const name = Object.keys(files)[0];
    Object.assign(input.regression, { tests: 1, pass: 1, files: { [name]: { sha256: files[name].sha256, pass: 1 } } });
  }));
  run("failed", "passed", "configured", 1, mutate((input) => { input.regression.provenance.revision = "e".repeat(40); }));
  run("passed", "failed", "configured", 1, mutate((input) => { input.measurements.provenance.candidate = "wrong binary"; }));
  run("passed", "failed", "configured", 1, mutate((input) => {
    for (const trial of input.measurements.trials.hot.flat()) trial.baseline = "e".repeat(40);
  }));
  run("passed", "invalid", "configured", 1, mutate((input) => { input.measurements.metric = "legacy"; }));
  run("passed", "measured", "invalid", 1, { policy: { ...approval, metric: "legacy" } });
});

test("promotion rejects incomplete or mixed-provenance evidence", () => {
  // A schema-1 result cannot attest which host and revision actually ran the suite.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pp-old-evidence-"));
  try {
    const evidence = join(dir, "evidence.json");
    writeFileSync(evidence, JSON.stringify({ schema: 1, environment: { platform: "darwin", node: "v26.13.1",
      candidate: `ovnfs/v0.8.0/${"a".repeat(64)}`, integration: "b".repeat(40), workload: "c".repeat(64) },
      reliability: Object.fromEntries(["mount", "capture-and-cache", "experiment-and-derived", "restart", "retention", "explicit-delete", "teardown"].map((key) => [key, { status: "passed" }])),
      regression: { status: "passed", tests: 1, pass: 1, fail: 0, skipped: 0 } }));
    const r = spawnSync(process.execPath, [PP, "working-copy", "promotion", "--evidence", evidence], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.notEqual(JSON.parse(r.stdout).reliability, "passed");
  } finally { rmSync(dir, { recursive: true }); }
});

test("thread start rejects an invalid --reviews URL before allocating a thread", (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pp-cli-reviews-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  const pp = (...args) => spawnSync(process.execPath, [PP, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, PP_CONFIG: join(dir, "config.json"), PASEO_URL: "ws://127.0.0.1:1/ws" } });
  assert.equal(pp("new", "demo").status, 0);
  for (const url of ["not-a-pr", ""]) {
    const r = pp("thread", "start", "demo", "--title", "Review", "--task", "Review it", `--reviews=${url}`);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--reviews must be a https:\/\/github\.com\//);
  }
  assert.deepEqual(readdirSync(join(root, "demo", "threads")), []);
});

test("through the CLI: a refused option exits non-zero and creates nothing", () => {
  const root = join(mkdtempSync(join(realpathSync(tmpdir()), "pp-cli-")), "root");
  const r = spawnSync(process.execPath, [PP, "--root", root, "new", "demo", "--dry-run"], { encoding: "utf8", env: { ...process.env, PP_CONFIG: join(dirname(root), "config.json") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --dry-run for `pp new`/);
  assert.ok(!existsSync(root) || !readdirSync(root).length, "no project was made");
});
