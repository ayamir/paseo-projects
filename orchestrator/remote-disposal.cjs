// Fixed program sent over the configured SSH connection. Request data is JSON on stdin, never shell source.
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto"), { tmpdir } = require("node:os");
const { dirname, isAbsolute, join, relative, resolve } = require("node:path");
const limit = 32 * 1024 * 1024;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const inside = (p, root) => p === root || p.startsWith(root + "/");
const fail = (message) => { throw new Error(message); };
const stat = (p) => fs.lstatSync(p, { throwIfNoEntry: false, bigint: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (p) => isAbsolute(p) && resolve(p) === p && fs.realpathSync(p) === p;
const stable = (a, b) => b && ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((k) => a[k] === b[k]);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });
let bytesLeft = limit, entries = 10000, action, removalStarted = false;
const observed = new Map();
const inode = (st) => st && `${st.dev}:${st.ino}`;
const observedInodes = (roots) => new Set([...observed].filter(([p]) => roots.some((r) => inside(p, r))).map(([, st]) => inode(st)));
const visit = () => { if (--entries < 0) fail("SSH worktree inspection exceeded its entry budget"); };
function observe(p, info = stat(p)) {
  if (!info || (observed.has(p) && !stable(observed.get(p), info))) fail(`SSH checkout changed after inspection: ${p}`);
  observed.set(p, info);
  return info;
}
function read(p, max = limit) {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || !canonical(p) || before.size > BigInt(Math.min(max, bytesLeft))) fail(`SSH file cannot be safely read within budget: ${p}`);
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) fail(`SSH file changed during inspection: ${p}`);
      offset += n;
    }
    if (!stable(before, fs.fstatSync(fd, { bigint: true })) || !stable(before, stat(p)) || !canonical(p)) fail(`SSH file changed during inspection: ${p}`);
    observe(p, before);
    bytesLeft -= bytes.length;
    return bytes;
  } finally { fs.closeSync(fd); }
}
function git(cwd, args, what) {
  const r = spawnSync("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, env, maxBuffer: limit, timeout: 45000 });
  const text = r.stdout?.toString("utf8");
  if (r.status !== 0 || r.error || r.stderr?.length || !Buffer.from(text ?? "").equals(r.stdout ?? Buffer.alloc(0))) {
    fail(`${what}: ${r.error?.message ?? r.stderr?.toString().trim().slice(0, 2048) ?? "Git failed"}`);
  }
  return text;
}
function lines(text, sep = "\n") {
  if (!text) return [];
  if (!text.endsWith(sep)) fail("incomplete SSH Git inspection output");
  return text.slice(0, -sep.length).split(sep);
}
function id(p) {
  const s = stat(p);
  if (!s?.isDirectory() || !canonical(p)) fail(`SSH Git directory identity could not be verified: ${p}`);
  return `${s.dev}:${s.ino}`;
}
function reflog(p, size) {
  const result = [];
  for (const row of lines(read(p, 1024 * 1024).toString("utf8"))) {
    const m = /^(\S+) (\S+) .+ -?\d+ [+-]\d{4}$/.exec(row.split("\t", 1)[0]);
    if (!m || m.slice(1).some((v) => !oid.test(v) || v.length !== size)) fail(`SSH Git reflog could not be verified: ${p}`);
    result.push(...m.slice(1).filter((v) => !/^0+$/.test(v)));
  }
  if (!result.length) fail(`SSH Git reflog could not be verified: ${p}`);
  return result;
}
function canonicalPrefix(p) {
  if (!isAbsolute(p)) fail(`invalid SSH dependency path: ${p}`);
  // Resolve parents too: a missing terminal component may live under an alias of the checkout.
  const s = stat(p);
  if (s) return fs.realpathSync.native(p);
  const parent = dirname(p);
  return join(canonicalPrefix(parent), relative(parent, p));
}
function registry(source) {
  const rows = lines(git(source, ["worktree", "list", "--porcelain", "-z"], "cannot inspect SSH Git registry"), "\0\0").map((row) => {
    const [p, ...fields] = row.split("\0");
    if (!p.startsWith("worktree /") || !fields.length) fail("malformed SSH Git worktree registry");
    return { path: p.slice(9), fields };
  });
  if (!rows.length) fail("empty SSH Git worktree registry");
  return rows;
}
function mounts(paths) {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") fail("SSH mount inspection is unavailable on this platform");
  const r = spawnSync(linux ? "findmnt" : "mount", linux ? ["--list", "--noheadings", "--raw", "--output", "TARGET"] : [],
    { encoding: "utf8", maxBuffer: limit, timeout: 45000 });
  if (r.status !== 0 || r.error || r.stderr || !r.stdout) fail("SSH mount inspection failed or unavailable");
  for (const line of lines(r.stdout)) {
    const p = linux ? line : /^[^\n]+? on (\/[^\n]*?) \([^()]*\)$/.exec(line)?.[1];
    if (!p || !isAbsolute(p) || /[\\�]/.test(p) || (!linux && p.includes(" on "))) fail("SSH mount inspection returned an ambiguous path");
    const normalized = resolve(p);
    if (paths.some((root) => inside(normalized, root) || inside(canonicalPrefix(normalized), root))) fail(`SSH worktree contains a mount: ${p}`);
  }
}
function lsofPath(text) {
  const escapes = { "\\": "\\", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  const bytes = text.replace(/\\(?:x([\da-fA-F]{2})|([\s\S])|$)/g, (_, hex, char) => {
    if (hex && hex !== "00") return String.fromCharCode(Number.parseInt(hex, 16));
    if (Object.hasOwn(escapes, char)) return escapes[char];
    fail("SSH occupancy probe returned an ambiguous file path");
  });
  return Buffer.from(bytes, "latin1");
}
function occupancy(paths) {
  const owned = observedInodes(paths);
  const occupied = (path) => paths.some((p) => inside(path.toString("latin1"), p));
  const matches = (path) => {
    for (let p = path; ; p = p.subarray(0, Math.max(1, p.lastIndexOf("/")))) {
      if (occupied(p)) return true;
      try {
        const st = stat(p);
        if (st) {
          const real = fs.realpathSync.native(p, { encoding: "buffer" });
          if (occupied(real)) return true;
          const current = p.equals(real) ? st : stat(real);
          if (current) return owned.has(inode(current));
        }
      } catch (e) {
        if (!["EACCES", "EPERM", "ENOENT"].includes(e.code)) throw e;
      }
      // Other users' paths can be unreadable. Check the nearest visible ancestor, including aliases.
      if (p.length === 1) fail("SSH occupancy path has no verifiable ancestor");
    }
  };
  const r = spawnSync("lsof", ["-nP", "-F0pn"], { encoding: "latin1", maxBuffer: limit, timeout: 45000 });
  if (r.status !== 0 || r.error || r.stderr || !r.stdout?.endsWith("\0\n")) fail("SSH occupancy probe failed or unavailable");
  let pid = 0, files = 0;
  const inspected = new Set();
  for (const row of lines(r.stdout, "\0\n")) {
    const [p, n, extra] = row.split("\0");
    if (/^p[1-9]\d*$/.test(p) && n === undefined) pid = Number(p.slice(1));
    else if (pid && /^f.+/.test(p) && n?.startsWith("n") && extra === undefined) {
      files++;
      const path = n.slice(1);
      if (pid === process.pid || !path.startsWith("/") || inspected.has(path)) continue;
      const bytes = lsofPath(path), deleted = " (deleted)";
      if (matches(bytes) || (path.endsWith(deleted) && matches(bytes.subarray(0, -deleted.length)))) {
        fail(`SSH worktree occupied by process ${pid}`);
      }
      inspected.add(path);
    } else fail("SSH occupancy probe returned malformed output");
  }
  if (!files) fail("SSH occupancy probe returned no file records");
}
function checkout(request) {
  const { w, td, dependencies, expected } = request;
  const { path, source, identity, nonce } = w;
  const gd = identity.git_dir, common = dirname(dirname(gd));
  if (!/^[a-f0-9-]{36}$/.test(nonce) || !oid.test(w.baseline) || dirname(gd) !== join(common, "worktrees") ||
      [path, source, gd].some((p) => !isAbsolute(p) || resolve(p) !== p || /[^\x20-\x7e]|\\/.test(p)) || path === source || inside(common, path)) fail("unsupported SSH worktree registration");
  const repository = id(common);
  // Do not load executable filters, config includes or alternate Git storage on the deletion path.
  const config = join(common, "config");
  read(config, 1024 * 1024);
  const keys = lines(git(tmpdir(), ["config", "--file", config, "--no-includes", "--name-only", "--null", "--list"], "cannot inspect SSH Git config"), "\0");
  if (keys.some((k) => /^(?:filter\.|include(?:if)?\.|extensions\.(?!objectformat$)|core\.(?:worktree|attributesfile|alternaterefscommand|sparsecheckout)$)/.test(k)) ||
      ["shallow", "info/grafts", "objects/info/alternates", "objects/info/http-alternates"].some((p) => stat(join(common, p)))) fail("unsupported SSH Git configuration or object storage");
  id(join(common, "objects"));
  if (!canonical(source) || git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "cannot verify SSH repository") !== `${common}\n`) fail("SSH source repository does not match registration");
  const rows = registry(source);
  const target = rows.filter((r) => r.path === path);
  if (action === "status") {
    if (!expected || repository !== expected.repository) fail("SSH backend repository identity changed");
    const directory = stat(path), registration = stat(gd);
    if (directory && registration && target.length === 1) return { gone: false };
    if (directory || registration || target.length) fail("SSH backend removal could not be verified");
    return { gone: true };
  }
  const roots = [path, gd];
  const checkDependencies = (rows) => {
    const registration = rows.filter((r) => r.path === path);
    if (registration.length !== 1 || registration[0].fields.some((f) => /^(locked|prunable)( |$)/.test(f))) fail("SSH worktree registration is missing, locked or prunable");
    const owned = observedInodes(roots);
    for (const p of [...dependencies, source, ...rows.filter((r) => r.path !== path).map((r) => r.path)]) {
      const real = canonicalPrefix(p);
      if (roots.some((root) => inside(resolve(p), root) || inside(real, root))) fail(`SSH dependency uses this worktree: ${p}`);
      for (let parent = real; parent !== "/"; parent = dirname(parent)) {
        if (owned.has(inode(stat(parent)))) fail(`SSH dependency uses this worktree: ${p}`);
      }
    }
  };
  for (const _ of [...dependencies, ...rows]) visit();
  checkDependencies(rows);
  mounts(roots);
  const verifyIdentity = () => {
    if (id(path) !== identity.directory || id(gd) !== identity.registration || id(common) !== repository ||
        read(join(path, ".git"), 4096).toString() !== `gitdir: ${gd}\n` || read(join(gd, "gitdir"), 4096).toString() !== `${path}/.git\n` ||
        read(join(gd, "commondir"), 4096).toString() !== "../..\n" || read(join(gd, "pp-working-copy"), 4096).toString() !== `${nonce}\n` || stat(join(gd, "locked"))) {
      fail("SSH worktree identity changed or registration is locked");
    }
  };
  verifyIdentity();
  // shortcut: complex per-worktree metadata (including private refs) is retained until its deletion effects can be inspected.
  observe(gd);
  for (const name of fs.readdirSync(gd, { encoding: "buffer" })) {
    visit();
    const file = name.toString(), p = join(gd, file);
    if (!name.equals(Buffer.from(file)) || !["HEAD", "index", "gitdir", "commondir", "pp-working-copy", "logs", "refs", "ORIG_HEAD", "COMMIT_EDITMSG"].includes(file)) fail(`unsupported SSH worktree Git metadata: ${file}`);
    const info = observe(p);
    if (!canonical(p) || !(["logs", "refs"].includes(file) ? info.isDirectory() : info.isFile())) fail(`unconfirmed SSH worktree Git metadata: ${file}`);
  }
  if (fs.readdirSync(join(gd, "logs")).join("\n") !== "HEAD" || (stat(join(gd, "refs")) && fs.readdirSync(join(gd, "refs")).length)) fail("unsupported SSH worktree Git logs or private refs");
  const run = (args, what) => git(path, args, what);
  if (run(["rev-parse", "--show-toplevel"], "cannot verify SSH checkout root") !== `${path}\n` ||
      run(["rev-parse", "--absolute-git-dir"], "cannot verify SSH checkout Git directory") !== `${gd}\n`) fail("SSH worktree identity changed");
  const [head] = lines(run(["rev-parse", "--verify", "HEAD^{commit}"], "cannot inspect SSH HEAD"));
  const branch = `refs/heads/${w.branch}`;
  if (!oid.test(head) || !oid.test(w.baseline) || !w.branch) fail("cannot verify SSH commit identity");
  run(["check-ref-format", branch], "cannot verify SSH branch name");
  const decl = td && join(td, "cleanup.json");
  if (td && (td === path || !inside(td, path) || resolve(td) !== td)) fail("unconfirmed SSH thread directory");
  const declared = decl && stat(decl);
  const d = declared ? JSON.parse(read(decl, 1024 * 1024)) : {};
  if (!d || typeof d !== "object" || Array.isArray(d)) fail("SSH cleanup.json must be an object");
  for (const key of ["keep", "discard", "save"]) {
    if (d[key] != null && (!Array.isArray(d[key]) || d[key].some((e) => typeof e?.path !== "string" || !e.path.trim()))) fail(`invalid SSH cleanup.json ${key} declaration`);
  }
  if (declared ? d.keep?.length : request.pathKeep) return { pathKeep: true };
  if (d.discard?.length) fail("SSH declared discard has no verified remote product/path checker");
  const saves = (d.save ?? []).map(({ path: value }) => {
    const p = resolve(td, value), parts = relative(path, p).split("/");
    if (p === path || !inside(p, path) || parts.includes(".git") || (parts.includes(".paseo-project") && (!inside(p, td) || p === td)) || !canonical(p)) fail(`unsafe SSH save path: ${value}`);
    return p;
  });
  const commits = d.commits ?? [];
  if (!Array.isArray(commits) || commits.some((c) => typeof c !== "string" || !oid.test(c) || c.length !== head.length)) fail("SSH cleanup.json commits must be full commit IDs");
  const orig = stat(join(gd, "ORIG_HEAD")) ? lines(read(join(gd, "ORIG_HEAD"), 256).toString()) : [];
  const tips = [...new Set([head, ...orig, ...reflog(join(gd, "logs", "HEAD"), head.length), ...reflog(join(common, "logs", branch), head.length),
    ...lines(run(["for-each-ref", "--format=%(objectname)", branch], "cannot inspect SSH branch tip"))])];
  if (tips.some((c) => !oid.test(c) || c.length !== head.length)) fail("cannot inspect SSH worktree-local commits");
  const extra = run(["rev-list", "--max-count=1", ...tips, `^${w.baseline}`, "--not", ...commits], "cannot inspect SSH private commits").trim();
  if (extra) fail(`commit ${extra} not declared for preservation in SSH cleanup.json commits`);
  const tracked = new Map(lines(run(["ls-files", "-z", "-v", "--stage"], "cannot inspect SSH Git index"), "\0").map((row) => {
    const m = /^H (100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(row);
    if (!m || m[2].length !== head.length) fail("SSH Git index has hidden, conflicted or unsupported entries");
    return [m[3], [m[1], m[2]]];
  }));
  if (run(["diff-index", "--cached", "--raw", "-z", "HEAD", "--"], "cannot inspect SSH staged files")) fail("unclassified SSH Git modifications");
  const files = Object.create(null), data = Object.create(null);
  const device = stat(path).dev;
  function walk(dir) {
    const before = observe(dir);
    const entries = fs.readdirSync(dir, { encoding: "buffer" }).sort(Buffer.compare);
    for (const raw of entries) {
      visit();
      const name = raw.toString(), p = join(dir, name), rel = relative(path, p);
      if (!raw.equals(Buffer.from(name)) || /[\x00-\x1f\x7f\\]/.test(rel)) fail(`unsupported SSH worktree filename in ${dir}`);
      if (rel === ".git") continue;
      const st = observe(p);
      if (st.dev !== device || name.toLowerCase() === ".git") fail(`cannot verify SSH dependencies at ${rel}`);
      const entry = tracked.get(rel);
      if (entry) {
        const mode = st.isSymbolicLink() ? "120000" : st.isFile() ? (st.mode & 0o100n ? "100755" : "100644") : "";
        if (mode !== entry[0]) fail(`unclassified SSH Git modifications: ${rel}`);
        const value = st.isSymbolicLink() ? fs.readlinkSync(p, { encoding: "buffer" }) : read(p);
        const blob = createHash(head.length === 40 ? "sha1" : "sha256").update(`blob ${value.length}\0`).update(value).digest("hex");
        if (blob !== entry[1] || !stable(st, stat(p))) fail(`unclassified SSH Git modifications: ${rel}`);
        tracked.delete(rel);
      } else if (st.isDirectory() && canonical(p)) {
        if (!walk(p) && !saves.some((s) => inside(p, s)) && !(td && inside(p, join(td, "library")))) fail(`unclassified SSH empty directory: ${rel}`);
      } else {
        if (!(td && ([join(td, "report.md"), join(td, "brief.md"), decl].includes(p) || inside(p, join(td, "library")))) && !saves.some((s) => inside(p, s))) fail(`unclassified SSH file: ${rel}`);
        if (!st.isFile()) fail(`cannot preserve non-regular SSH file: ${rel}`);
        const value = read(p);
        files[rel] = hash(value);
        if (action === "capture") data[rel] = value.toString("base64");
      }
    }
    if (!stable(before, stat(dir))) fail(`SSH directory changed during inspection: ${dir}`);
    return entries.length;
  }
  walk(path);
  if (tracked.size) fail(`unclassified SSH Git modifications: missing ${tracked.keys().next().value}`);
  checkDependencies(rows);
  const manifest = { nonce, repository, head, commits, files, ignored: Object.keys(files) };
  if (action === "inspect") {
    occupancy(roots);
    return { manifest };
  }
  if (action !== "capture" && action !== "remove") fail("invalid SSH cleanup action");
  const temp = fs.realpathSync(tmpdir());
  if (inside(temp, path) || inside(temp, gd)) fail("SSH staging directory must be outside the worktree");
  const stage = fs.mkdtempSync(join(temp, "pp-disposal-"));
  try {
    if (action === "capture") {
      occupancy(roots);
      const bare = join(stage, "export.git"), bundle = join(stage, "commits.bundle");
      git(stage, ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", `--object-format=${head.length === 64 ? "sha256" : "sha1"}`, bare], "cannot prepare SSH commit bundle");
      fs.writeFileSync(join(bare, "objects", "info", "alternates"), `${join(common, "objects")}\n`, { flag: "wx" });
      git(bare, ["update-ref", "refs/heads/main", head], "cannot locate SSH HEAD object");
      for (const c of commits) git(bare, ["update-ref", `refs/heads/saved/${c}`, c], "cannot locate declared SSH commit");
      git(bare, ["bundle", "create", bundle, "HEAD", "--all"], "cannot create SSH commit bundle");
      return { manifest, data, bundle: read(bundle).toString("base64") };
    }
    if (!expected || JSON.stringify(manifest) !== JSON.stringify(expected)) fail("SSH evidence is stale: checkout contents changed");
    const excludes = join(stage, "excludes");
    fs.writeFileSync(excludes, manifest.ignored.map((p) => `/${p.replace(/[\\*?[\] ]/g, "\\$&")}\n`).join(""), { flag: "wx" });
    const lock = join(common, `pp-disposal-${nonce}.lock`);
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code === "EEXIST") fail("SSH removal lease is still present; previous remote operation may be in progress");
      throw e;
    }
    const lease = id(lock);
    try {
      mounts(roots);
      occupancy(roots);
      checkDependencies(registry(source));
      verifyIdentity();
      for (const p of observed.keys()) observe(p);
      removalStarted = true;
      git(source, ["-c", "status.showUntrackedFiles=all", "-c", `core.excludesFile=${excludes}`, "worktree", "remove", "--", path], "SSH backend worktree removal failed");
      if (stat(path) || stat(gd) || id(common) !== repository || registry(source).some((r) => r.path === path)) fail("SSH backend removal could not be verified");
      return { gone: true };
    } finally { if (id(lock) === lease) fs.rmdirSync(lock); }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

try {
  const input = Buffer.alloc(1024 * 1024);
  let n = 0, count;
  while (n < input.length && (count = fs.readSync(0, input, n, input.length - n, null))) n += count;
  if (n === input.length) fail("SSH cleanup request exceeded its budget");
  const request = JSON.parse(input.subarray(0, n).toString());
  action = request.action;
  process.stdout.write(JSON.stringify(checkout(request)));
} catch (e) {
  const key = action === "remove" && !removalStarted ? "blocked" : "error";
  process.stdout.write(JSON.stringify({ [key]: `SSH cleanup: ${e.message.slice(0, 4096)}` }));
}
