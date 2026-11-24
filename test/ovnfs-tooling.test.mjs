import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { finishFixture, stopOwnedDaemon } from "../scripts/ovnfs-fixture.mjs";
import { measure } from "../scripts/ovnfs-measure.mjs";

test("fixture retains uncertain state but still attempts ordinary OVNFS stop after fake Paseo times out", async () => {
  const events = [];
  await assert.rejects(finishFixture([
    () => { throw new Error("fake Paseo did not exit"); },
    () => events.push("OVNFS stop"),
    () => events.push("verify mounts"),
  ], () => events.push("release children"), () => events.push("remove directory")), /fake Paseo did not exit.*fixture retained/);
  assert.deepEqual(events, ["OVNFS stop", "verify mounts", "release children"]);
});

test("an already exited fixture daemon is not an ordinary stop, even with exit zero", async () => {
  await assert.rejects(stopOwnedDaemon({ result: { code: 0 } }, () => assert.fail("must not probe a dead daemon"),
    () => assert.fail("must not send a stop request")), /exited before ordinary stop/);
});

function syntheticFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pp-measure-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "checkout"), calls = [];
  return {
    dir, repo: join(dir, "repo"), project: join(dir, "project"), root: join(dir, "root"), state: join(dir, "state"), calls,
    scrub: (s) => s, git: async () => "1".repeat(40), startPaseo: async () => {}, startOvnfs: async () => 1,
    proveMount: async () => {}, agents: () => [{ id: "fake", cwd: path }], cleanup: async () => {},
    node: async () => "9fc682e5ba908e3f917a91f74dfe679c61e4c12af7a621a3c157ee1eda146e3e",
    size: async () => ({ logical_bytes: 1, allocated_bytes: 1 }),
    async cli(...args) {
      calls.push(args);
      if (args[0] === "--json") return "[]";
      return "started t-0001 fixture agent fake";
    },
    async show() {
      await delay(30);
      return { working_copy: { path, cache: { state: ++this.shows <= 2 ? "reused" : "cold" } } };
    }, shows: 0,
  };
}

test("the matched measurement records a failing mount probe as preflight and never dispatches", async (t) => {
  const f = syntheticFixture(t);
  f.proveMount = async () => { throw new Error("owned mount not proven"); };
  const result = await measure(f, "ovnfs", "cold");
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "cold launch preflight: owned mount not proven");
  assert.ok(!f.calls.some(([a, b]) => a === "thread" && b === "start"));
  assert.equal(result.first_use_ms, undefined);
});

test("matched useful time excludes mount probes and post-build checks but inclusive time retains them", async (t) => {
  const f = syntheticFixture(t);
  f.proveMount = () => delay(30);
  const result = await measure(f, "ovnfs", "hot");
  assert.equal(result.status, "passed", result.reason);
  const outside = result.steps.filter(({ name }) => /^(reuse|invalidated).*(preflight|verification)$/.test(name));
  assert.equal(outside.length, 6);
  assert.ok(result.inclusive_total_ms - result.total_ms >= outside.reduce((sum, step) => sum + step.ms, 0) - 1);
  assert.ok(result.first_use_ms < result.total_ms);
  assert.equal(result.digests.length, 3);
});
