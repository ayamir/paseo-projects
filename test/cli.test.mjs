// The command line's declarations (orchestrator/cli.mjs): every option a usage line shows is accepted for that
// command, and any other option is refused before the command runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES, HELP, VALUE_FLAGS, check, parse } from "../orchestrator/cli.mjs";

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
