#!/usr/bin/env node
// One-shot cutover from herdr-projects to paseo-projects (README "从 herdr 切换"): stop both
// tickers, make the herdr root paseo-projects' root and convert its projects in place (reading
// each live pane's session), close herdr's project panes, then open each coordinator and restart
// each open thread, both on their old Claude sessions.
//   node bin/cutover-herdr.mjs [HERDR_ROOT] [--dry-run] [--yes] [--wait]
// --wait: no pane is closed mid-turn; it waits until none of them is working.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, parseToml, readText, readJson, requirePerson, ask } from "../orchestrator/lib.mjs";
import { canonical, editConfig } from "../orchestrator/config.mjs";

process.on("uncaughtException", (e) => { console.error(`error: ${e.message}`); process.exit(1); });

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), yes = args.includes("--yes"), wait = args.includes("--wait");
const herdrRoot = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".herdr-projects");

const run = (bin, ...a) => execFileSync(bin, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pp = (...a) => run(process.execPath, join(REPO, "bin", "pp.mjs"), ...a);
const errOf = (e) => String(e.stderr || e.message).trim().split("\n").pop();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function herdrProjectsBin() {
  if (process.env.HP_BIN) return process.env.HP_BIN;
  const d = join(homedir(), ".config", "herdr", "plugins", "github");
  const n = existsSync(d) && readdirSync(d).find((x) => x.startsWith("herdr-projects-"));
  const bin = n && join(d, n, "target", "release", "herdr-projects");
  if (!bin || !existsSync(bin)) throw new Error("herdr-projects binary not found; set HP_BIN");
  return bin;
}
const herdrPane = (id) => { try { return JSON.parse(run("herdr", "pane", "get", id)).result.pane; } catch { return null; } };

// ------------------------------------------------------------ what there is

const HP = herdrProjectsBin();
const slugs = readdirSync(herdrRoot).filter((n) => existsSync(join(herdrRoot, n, "PROJECT.md")));
let self = null;
try { self = JSON.parse(run("herdr", "pane", "current")).result.pane.pane_id; } catch {}

// herdr's coordinator and open-thread panes. Pane ids are reused, so a pane counts only when its cwd is still the record's.
function scan() {
  const panes = [];
  for (const s of slugs) {
    const d = join(herdrRoot, s);
    const coords = [readJson(join(d, ".state", "coordinator.json"), null), ...(readJson(join(d, ".state", "coordinators.json"), []) ?? [])];
    const want = coords.filter((c) => c?.pane_id).map((c) => [c.pane_id, d, `${s} coordinator`]);
    for (const n of readdirSync(join(d, "threads")).filter((x) => /^t-\d{4,}\.toml$/.test(x))) {
      const t = parseToml(readText(join(d, "threads", n)), n);
      if (t.status !== "resolved" && t.pane_id) want.push([t.pane_id, t.cwd || t.worktree_path, `${s} ${t.id}`]);
    }
    for (const [id, cwd, label] of want) {
      const p = id !== self && !panes.some((x) => x.id === id) ? herdrPane(id) : null;
      if (p && (p.cwd === cwd || p.foreground_cwd === cwd)) panes.push({ id, label, status: p.agent_status ?? "" });
    }
  }
  return panes;
}
let panes = scan();
const working = () => panes.filter((p) => p.status === "working");
const root = canonical(herdrRoot);

console.log(`paseo-projects root becomes ${root}`);
console.log(`1. stop the herdr-projects and pp tickers${wait ? ", then wait until no pane below is working" : ""}`);
console.log(`2. set root in config.json, convert ${slugs.join(", ")} in place (herdr's own state files go to .state/herdr/; sessions from the live panes)`);
console.log(`3. close ${panes.length} herdr pane(s)${panes.length ? ":" : ""}`);
for (const p of panes) console.log(`     ${p.id}  ${p.label}  (${p.status || "?"})`);
console.log(`4. open each coordinator and restart each open thread on its old session`);
if (dry) process.exit(0);
if (working().length && !wait) console.log("warning: a working pane loses its current turn (the conversation up to it is kept); --wait waits for it");
if (!yes) { requirePerson("cutover without --yes"); if (ask("go on? [y/N] ").toLowerCase() !== "y") process.exit(1); }

// ------------------------------------------------------------ the cutover

const stopHerdrTicker = () => { try { run(HP, "--root", herdrRoot, "ticker", "stop"); } catch {} };
stopHerdrTicker();
console.log(pp("ticker", "stop").trim());
if (wait) {
  // shortcut: no time limit; Ctrl-C here stops before anything but the tickers has changed.
  // Rescanned each time: a coordinator still at work may open more threads.
  while (working().length) {
    console.log(`waiting for ${working().map((p) => p.label).join(", ")} to finish their turn…`);
    sleep(15_000);
    panes = scan();
  }
}
stopHerdrTicker();
sleep(3000);
// A herdr plugin may start it again; then two tickers would drive the same threads.
if (/ticker: running/.test(run(HP, "--root", herdrRoot, "ticker", "status"))) throw new Error("the herdr-projects ticker is running again; disable what starts it, then run this again");

// Converted while the panes still run, so each thread's session comes from its own pane.
editConfig((raw) => { raw.root = root; });
console.log(`config.json: root = ${root}`);
process.stdout.write(pp("migrate-herdr", herdrRoot));

for (const p of panes) {
  try { run("herdr", "pane", "close", p.id); console.log(`closed ${p.id} (${p.label})`); }
  catch (e) { throw new Error(`could not close ${p.id} (${p.label}): ${errOf(e)}; close it by hand, then run this again`); }
}

const failed = [];
const projects = JSON.parse(pp("list", "--json")).filter((p) => slugs.includes(p.slug));
for (const { slug } of projects) {
  try { console.log(`${slug}: ${pp("open", slug).trim().split("\n").join("; ")}`); }
  catch (e) { failed.push(`${slug} coordinator: ${errOf(e)}`); }
  for (const t of JSON.parse(pp("thread", "list", slug, "--json")).filter((t) => t.status !== "resolved" && !t.agent_id)) {
    try { console.log(`${slug}: ${pp("thread", "restart", slug, t.id).trim()}`); }
    catch (e) { failed.push(`${slug} ${t.id}: ${errOf(e)}`); }
  }
}

console.log(failed.length ? `\nnot picked up (\`--fresh\` starts them new):\n  ${failed.join("\n  ")}` : "\nall coordinators and open threads are up");
console.log("left to you: remove the herdr-projects hooks from ~/.claude/settings.json; `pp list` and `pp ticker status` to check");
process.exitCode = failed.length ? 1 : 0;
