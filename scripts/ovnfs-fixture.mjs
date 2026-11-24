import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const checkout = fileURLToPath(new URL("..", import.meta.url));
const pp = fileURLToPath(new URL("../bin/pp.mjs", import.meta.url));
const fakePaseo = fileURLToPath(new URL("../test/fixtures/fake-paseo.mjs", import.meta.url));
const admin = fileURLToPath(new URL("../orchestrator/ovnfs-admin.mjs", import.meta.url));
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function command(bin, args, env, timeout = 15_000, cwd) {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { env, cwd, timeout, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      clearTimeout(alarm);
      resolve({ ok: !error, stdout, stderr, error: error?.killed ? "timed out" : error?.code });
    });
    // A blocked kernel NFS operation may outlive its user-space timeout.
    const alarm = setTimeout(() => {
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok: false, stdout: "", stderr: "", error: "timed out" });
    }, timeout + 1000);
  });
}

function started(bin, args, env, log, cwd) {
  const fd = openSync(log, "a", 0o600);
  const child = spawn(bin, args, { env, cwd, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let result;
  const done = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(result = { code, signal }));
    child.once("error", (error) => resolve(result = { error }));
  });
  return { child, done, get result() { return result; } };
}

async function waitForExit(process, timeout) {
  let timer;
  try { return await Promise.race([process.done, new Promise((resolve) => { timer = setTimeout(resolve, timeout); })]); }
  finally { clearTimeout(timer); process.child.unref(); }
}

export async function stopOwnedDaemon(daemon, confirm, request) {
  requireThat(!daemon.result, "fixture daemon exited before ordinary stop; mount and state retained");
  const status = await confirm();
  requireThat(status && !daemon.result, "running fixture daemon identity could not be confirmed for stop");
  await request(status);
  requireThat((await waitForExit(daemon, 5000))?.code === 0, "fixture daemon did not exit normally after one ordinary stop");
}

export async function finishFixture(steps, release, remove) {
  const errors = [];
  try {
    for (const step of steps) {
      try { await step(); }
      catch (e) { errors.push(e.message); }
    }
    requireThat(!errors.length, `${errors.join("; ")}; fixture retained`);
    await remove();
  } finally { release(); }
}

export function tools(ovnfs, git) {
  for (const bin of [ovnfs, git]) requireThat(bin && isAbsolute(bin) && lstatSync(realpathSync(bin)).isFile(), "pass absolute paths to the pinned ovnfs and git executables");
  return { ovnfs: realpathSync(ovnfs), git: realpathSync(git) };
}

export function fixture(binaries) {
  // Short canonical paths fit Darwin's Unix socket limit. Each namespace is private to this process.
  const dir = mkdtempSync(join(realpathSync("/tmp"), "pp-ovnfs-"));
  const [home, bin, state, mount, root, repo] = ["home", "bin", "s", "mnt", "pp", "repo"].map((name) => join(dir, name));
  for (const path of [home, bin, state, mount, root, repo]) mkdirSync(path, { mode: 0o700 });
  for (const [name, path] of Object.entries({ ...binaries, node: process.execPath })) symlinkSync(path, join(bin, name));
  const config = join(dir, "config.json"), projectFile = join(dir, "project"), agentsFile = join(dir, "agents");
  writeFileSync(config, JSON.stringify({ profiles: { fixture: { provider: "claude/fixture" } } }));
  writeFileSync(projectFile, repo);
  writeFileSync(agentsFile, "");
  // Fail closed for offline tools. GitHub's only simulated PR is the fixture review used by ticker.
  writeFileSync(join(bin, "gh"), `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then printf '%s\\n' '{"state":"MERGED"}'; else printf '%s\\n' '[]'; fi
`, { mode: 0o700 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, XDG_CONFIG_HOME: home, TMPDIR: dir, LC_ALL: "C",
    PP_CONFIG: config, PP_CODEBASE_MEMORY_BIN: "/usr/bin/false", PASEO_URL: "ws://127.0.0.1:1/ws",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    OVNFS_STATE: state, OVNFS_MOUNT: mount, OVNFS_GIT_REMOTES: "0",
    FAKE_PASEO_PROJECT: projectFile, FAKE_PASEO_AGENTS: agentsFile,
  };
  const scrub = (text) => {
    for (const path of [dir, checkout, process.execPath, ...Object.values(binaries), process.env.HOME].filter(Boolean)) text = text.replaceAll(path, `<${path === dir ? "fixture" : "local"}>`);
    return text.replace(/(pp-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "$1<fixture-id>").replace(/occupied by process \d+/g, "occupied by fixture process");
  };
  const run = (bin, args, timeout) => command(bin, args, env, timeout);
  async function checked(label, bin, args, timeout) {
    const r = await run(bin, args, timeout);
    requireThat(r.ok, `${label}: ${scrub(r.stderr.trim() || r.stdout.trim() || String(r.error)).split("\n").slice(0, 3).join(" | ")}`);
    return r.stdout.trim();
  }
  const node = (label, args, timeout) => checked(label, process.execPath, args, timeout);
  const git = (cwd, ...args) => checked(`git ${args[0]}`, binaries.git, ["-C", cwd, ...args]);
  const cli = (...args) => node(`pp ${args.slice(0, 2).join(" ")}`, [pp, "--root", root, ...args], 50_000);
  const show = async (id) => JSON.parse(await cli("--json", "thread", "show", "fixture", id));
  const project = join(root, "fixture");
  const attempt = (...args) => run(process.execPath, [pp, "--root", root, ...args], 50_000);
  const backend = (verb) => run(binaries.ovnfs, ["--state", state, "--mount", mount, "--json", verb], 1500);
  const fixtureMounts = async () => (await checked("mount table", "/sbin/mount", [], 3000)).split("\n").filter((row) => row.includes(` on ${dir}/`) || row.includes(` on ${dir} (`));
  let daemon, paseo, occupantUncertain = false, mounted = false, stopping = false;

  async function startPaseo() {
    const log = join(dir, "paseo.log");
    paseo = started(process.execPath, [fakePaseo], env, log, dir);
    for (let tries = 0; tries < 100; tries++) {
      const port = readFileSync(log, "utf8").split("\n")[0];
      if (/^\d+$/.test(port)) { env.PASEO_URL = `ws://127.0.0.1:${port}/ws`; return; }
      if (paseo.result) break;
      await delay(50);
    }
    throw new Error("fake Paseo did not start on loopback");
  }

  async function bound() {
    const r = await backend("status"); // status does not auto-start
    if (!r.ok) return null;
    const status = JSON.parse(r.stdout);
    requireThat(status.state === state && status.mount === mount && status.socket === join(state, "admin.sock") &&
      status.pid === daemon?.child.pid && status.build_version === "v0.8.0" && status.proto === "nfs", "daemon endpoint or PID is not owned by this fixture");
    return status;
  }

  async function proveMount() {
    const status = await bound();
    requireThat(status?.port === 0, "owned daemon did not mount local NFS over its Unix socket");
    const result = JSON.parse(await checked("nfsstat", "/usr/bin/nfsstat", ["-f", "JSON", "-m", mount], 3000));
    const rows = Object.values(result).filter((row) => row?.["Mount Point"] === mount);
    const socket = join(state, "nfs.sock");
    requireThat(rows.length === 1 && ["vers=3", "ticotsord", `port=${socket}`, `mountport=${socket}`].every((arg) => rows[0]["Current mount parameters"]?.["NFS parameters"]?.includes(arg)), "mounted NFS endpoint does not match the owned Unix socket");
  }

  async function startOvnfs() {
    requireThat(!daemon && !existsSync(join(state, "admin.sock")) && !(await fixtureMounts()).length &&
      realpathSync(state) === state && realpathSync(mount) === mount, "fixture namespace already has a daemon or mount");
    const version = await backend("version");
    requireThat(version.ok, "could not read OVNFS version");
    const info = JSON.parse(version.stdout);
    requireThat(info.version === "v0.8.0" && info.os === "darwin" && info.arch === process.arch, "expected native macOS OVNFS v0.8.0");
    const log = join(dir, "serve.log"), offset = existsSync(log) ? lstatSync(log).size : 0;
    const at = performance.now();
    daemon = started(binaries.ovnfs, ["serve", "--state", state, "--mount", mount, "--proto", "nfs", "--no-git-remotes"], env, log, dir);
    const deadline = at + 25_000;
    let failure;
    while (performance.now() < deadline && !daemon.result) {
      if (existsSync(join(state, "admin.sock"))) {
        try { await proveMount(); mounted = true; return performance.now() - at; }
        catch (e) { failure = e.message; }
      }
      await delay(100);
    }
    const diagnostics = readFileSync(log, "utf8").slice(offset).split("\n").filter((line) => /mount|denied|not permitted|listen|error/i.test(line));
    throw new Error(scrub(`OVNFS startup failed: ${[...diagnostics.slice(-4), failure].filter(Boolean).join(" | ") || "startup did not become ready within 25 s"}`));
  }

  async function stopOvnfs() {
    if (!daemon) return;
    requireThat(!stopping, "ordinary fixture stop already attempted; mount and state retained");
    await stopOwnedDaemon(daemon, bound, async (status) => {
      stopping = true;
      if (status.port === 0) await node("fixture stop", [admin, state, mount, "stop", "{}", "10000"], 11_000);
      else requireThat(daemon.child.kill("SIGTERM"), "could not request ordinary stop of the owned TCP fallback");
    });
    requireThat(!(await fixtureMounts()).length, "fixture mount is still present; mount and state retained");
    requireThat(!existsSync(join(state, "admin.sock")), "fixture admin socket persists; state retained");
    daemon = null;
    mounted = false;
    stopping = false;
  }

  async function registry() {
    await proveMount();
    const result = JSON.parse(await node("fixture registry", [admin, state, mount, "ls", "{}", "4000"], 5000));
    return { checkouts: result.checkouts ?? [], snapshots: result.snapshots ?? [] };
  }

  async function cleanup() {
    await finishFixture([async () => {
      if (!paseo || (paseo.result && !paseo.result.error)) return;
      requireThat(!paseo.result && paseo.child.kill("SIGTERM"), "could not request fake Paseo stop");
      requireThat(await waitForExit(paseo, 3000), "fake Paseo did not exit");
    }, stopOvnfs, async () => {
      requireThat(!occupantUncertain, "fixture occupant exit not confirmed");
      requireThat(!(await fixtureMounts()).length && !existsSync(join(state, "admin.sock")), "cannot exclude an active fixture mount or daemon");
    }], () => {
      paseo?.child.unref();
      daemon?.child.unref();
    }, () => checked("remove unmounted fixture", "/bin/rm", ["-r", dir], 15_000));
  }

  // Record the backing roots once. du -k reports allocated blocks, which may include shared extents.
  async function size(path) {
    const files = await checked("logical size", "/usr/bin/find", [path, "-type", "f", "-exec", "/usr/bin/stat", "-f", "%z", "{}", "+"], 5000);
    const blocks = await checked("allocated size", "/usr/bin/du", ["-sk", path], 5000);
    return { logical_bytes: files ? files.split("\n").reduce((sum, bytes) => sum + Number(bytes), 0) : 0, allocated_bytes: Number(blocks.split(/\s/)[0]) * 1024 };
  }

  async function occupy(path, action) {
    await proveMount();
    requireThat(path.startsWith(`${mount}/`) && await node("inspect occupied checkout", ["-e", "console.log(require('node:fs').realpathSync(process.argv[1]))", path], 5000) === path,
      "fixture occupant target is not a verified checkout");
    const log = join(dir, "occupant.log");
    const occupant = started(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], env, log, path);
    try {
      for (let tries = 0; tries < 20 && !readFileSync(log, "utf8").includes("ready"); tries++) await delay(50);
      requireThat(readFileSync(log, "utf8").includes("ready"), "fixture occupant did not start");
      return await action(occupant.child.pid);
    } finally {
      try {
        if (!occupant.result) occupant.child.kill("SIGTERM");
        const result = await waitForExit(occupant, 3000);
        if (!result || result.error) { occupantUncertain = true; throw new Error("fixture occupant exit not confirmed"); }
      } finally { occupant.child.unref(); }
    }
  }

  return { dir, state, mount, root, repo, project, scrub, git, cli, show, attempt, node, startPaseo, startOvnfs, stopOvnfs, proveMount, registry, cleanup, size, checked, occupy,
    get mounted() { return mounted; },
    agents: () => readFileSync(agentsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    version: () => checked("OVNFS version", binaries.ovnfs, ["--state", state, "--mount", mount, "--json", "version"]),
    tests: (files = readdirSync(join(checkout, "test")).filter((name) => name.endsWith(".test.mjs")).sort(), pattern) => {
      // Legacy registration tests compare Git reflog timestamps against thread creation.
      const { GIT_AUTHOR_DATE, GIT_COMMITTER_DATE, ...testEnv } = env;
      return command(process.execPath, ["--test", "--test-concurrency=1", ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files.map((name) => `test/${name}`)], testEnv, 600_000, checkout);
    },
    runTicker: () => node("ticker pass", ["--input-type=module", "-e", `
      import { tick } from ${JSON.stringify(new URL("../orchestrator/ticker.mjs", import.meta.url).href)};
      import { Project } from ${JSON.stringify(new URL("../orchestrator/project.mjs", import.meta.url).href)};
      await tick(new Project(process.argv[1], "fixture")); process.exit(0);
    `, root], 60_000),
  };
}
