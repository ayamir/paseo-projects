// Keep the source supplied to OVNFS separate from the user's working tree and Git metadata.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { requireCleanCheckout } from "./working-copy.mjs";

export const inputRoot = (project) => join(realpathSync(project.root), ".pp-working-copy-inputs");

export function checkCapacity(project, registered, h, { additions = 0, repo, namespace, inputs }) {
  const settings = project.settings();
  const limit = (key) => {
    const n = settings[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) throw new Error(`${key} must be a safe whole number or be unset`);
    return n;
  };
  const max = limit("working_copy_max_resources"), min = limit("working_copy_min_free_bytes");
  if (max !== undefined) {
    const rows = registered();
    const live = rows.filter((w) => w.phase !== "removed" || w.disposal?.phase !== "removed").length;
    const retained = new Set(rows.flatMap((w) => [w.seed?.path, w.ovnfs?.capture?.path].filter(Boolean))).size;
    if (live + retained + additions > max) throw new Error(`working-copy resource budget (${live} registered, ${retained} input repositories, ${additions} requested, limit ${max}); review retained resources or adjust working_copy_max_resources`);
  }
  if (min === undefined) return;
  const check = (free, volume) => {
    if (free < BigInt(min)) throw new Error(`working-copy space warning on ${volume} (${free} bytes free, floor ${min}); free space safely or adjust working_copy_min_free_bytes`);
  };
  if (repo) {
    const common = h.shell("git rev-parse --path-format=absolute --git-common-dir", repo, undefined, 5000);
    const gitDir = common.stdout.trim();
    if (!common.ok || !gitDir.startsWith("/")) throw new Error("could not verify free space at the Git data location");
    for (const [path, volume] of [[dirname(repo), "Git checkout"], [gitDir, "Git data"]]) {
      if (h.remote) {
        const r = h.shell("LC_ALL=C df -Pk .", path, undefined, 5000);
        const available = /\s\d+\s+\d+\s+(\d+)\s+\d+%\s/.exec(r.stdout.trimEnd().split("\n").at(-1) ?? "")?.[1];
        if (!r.ok || available === undefined) throw new Error(`could not verify free space on the remote ${volume} volume`);
        check(BigInt(available) * 1024n, volume);
      } else check(localFree(path), volume);
    }
  }
  if (namespace) for (const path of [namespace.state, join(namespace.state, "store"), join(namespace.state, "git")]) {
    check(localFree(path, true), "OVNFS storage");
  }
  if (inputs) check(localFree(inputRoot(project), true), "PP input repository storage");
}

function localFree(path, parentIfMissing = false) {
  let fs;
  try { fs = statfsSync(path, { bigint: true }); }
  catch (e) {
    if (parentIfMissing && e.code === "ENOENT") return localFree(dirname(path));
    throw new Error("could not verify free space on a working-copy allocation volume");
  }
  if (fs.bsize <= 0n || fs.bavail < 0n) throw new Error("working-copy allocation volume reports unknown free space");
  return fs.bsize * fs.bavail;
}

function gitRun(path, args, input, attrSource) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  if (attrSource) env.GIT_ATTR_SOURCE = attrSource;
  const r = spawnSync("git", ["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.fsync=all", "-c", "core.attributesFile=/dev/null", ...args], {
    env, input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 << 20,
  });
  if (r.status !== 0) throw new Error(`could not prepare or verify working-copy inputs (git ${args[0]})`);
  return r.stdout;
}

const git = (path, ...args) => gitRun(path, args);
const fetchOid = (path, source, oid) => git(path, "-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", "--no-recurse-submodules", "--", source, oid);

function privateDir(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || realpathSync(path) !== path || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n)) throw new Error("working-copy input storage is not a private directory");
  return `${stat.dev}:${stat.ino}`;
}

export function capturePlan(project, w) {
  return { path: join(inputRoot(project), w.nonce, "repo") };
}

function tree(path, oid) {
  return git(path, "ls-tree", "-r", "-z", oid).split("\0").filter(Boolean).map((row) => {
    const match = /^(100(?:644|755)) blob ([a-f0-9]+)\t([^\0]+)$/.exec(row);
    if (!match || !safePath(match[3])) throw new Error("clean capture does not support tracked links, submodules or unsafe paths");
    return { mode: match[1], oid: match[2], file: match[3] };
  });
}

const safePath = (name) => typeof name === "string" && !/[\u0000-\u001f\x7f\\�]/.test(name) &&
  name.split("/").every((part) => part && ![".", "..", ".git"].includes(part.toLowerCase()));
const localPath = (name) => /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.ssh|\.aws|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|ed25519)|credentials?)(?:\/|$)/i.test(name);

function readRegular(root, name) {
  const path = join(root, name);
  const parent = dirname(path);
  try { if (realpathSync(parent) !== parent) throw new Error("working-copy input crosses a symbolic link"); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error("working-copy input is not an unaliased regular file");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), entry = lstatSync(path, { bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size ||
        entry.ino !== after.ino || entry.dev !== after.dev || realpathSync(parent) !== parent) throw new Error("working-copy input changed during capture");
    return { bytes, mode: before.mode & 0o100n ? "100755" : "100644" };
  } finally { closeSync(fd); }
}

function verifySeedBytes(path, expected, reason) {
  try {
    for (const { file, mode, sha256 } of expected) {
      const current = readRegular(path, file);
      if ((current?.mode ?? "0") !== mode || (current ? digest(current.bytes) : null) !== sha256) throw new Error();
    }
  } catch { throw new Error(reason); }
}

const seedRoundTrip = "dirty seed does not round-trip to the source working-tree bytes";

function seedTree(w, stage, entries) {
  const zero = "0".repeat(w.baseline.length), expected = [], changes = [];
  git(stage, "read-tree", w.baseline);
  for (const { file, mode: baseMode, oid: baseOid } of entries) {
    const work = readRegular(w.source, file), mode = work?.mode ?? "0", sensitive = localPath(file);
    expected.push({ file, mode, sha256: work ? digest(work.bytes) : null });
    // Use only committed attributes and the isolated Git config for cleaning. Never
    // execute a source filter or read the original index/attributes/config.
    let oid = zero;
    if (work) {
      try {
        oid = gitRun(stage, ["hash-object", ...(sensitive ? [] : ["-w"]), `--path=${file}`, "--stdin"], work.bytes, w.baseline).trim();
      } catch { throw new Error(`${seedRoundTrip}: Git could not canonicalize the input`); }
      if (!/^[a-f0-9]+$/.test(oid) || oid.length !== zero.length) throw new Error("dirty seed object identity could not be verified");
    }
    if (oid === baseOid && mode === baseMode) continue;
    if (sensitive) throw new Error("dirty seed refuses changes to a credential or local configuration path");
    changes.push(`${mode} ${oid}\t${file}\0`);
  }
  verifySeedBytes(w.source, expected, "dirty source changed during seed capture");
  if (git(w.source, "rev-parse", "HEAD").trim() !== w.baseline) throw new Error("source HEAD changed during seed capture");
  if (!changes.length) return { oid: w.baseline, expected };
  gitRun(stage, ["update-index", "-z", "--index-info"], changes.join(""));
  const start = git(stage, "write-tree").trim();
  const oid = git(stage, "-c", "user.name=PP working-copy seed", "-c", "user.email=pp-seed@invalid", "commit-tree", start,
    "-p", w.baseline, "-m", "Explicit working-copy seed").trim();
  git(stage, "update-ref", "refs/heads/pp-seed", oid);
  return { oid, expected };
}

export function createCapture(project, w, capture, inheritDirty = false, { recoverOnly = false } = {}) {
  // A pre-capture OVNFS plan has no approved input boundary. Never retrofit it
  // on retry or send its original source to the daemon.
  if (!capture?.path) throw new Error("OVNFS record has no verified capture; start a new checkout explicitly");
  const root = inputRoot(project), owner = dirname(capture.path);
  if (capture.path !== capturePlan(project, w).path || dirname(owner) !== root ||
      relative(w.source, root).split("/")[0] !== ".." || relative(root, w.source).split("/")[0] !== "..") {
    throw new Error("working-copy input storage must be separate from the source repository");
  }
  const intent = { nonce: w.nonce, baseline: w.baseline, source: w.source, dirty: inheritDirty };
  let existing = recoverOnly;
  if (!recoverOnly) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    privateDir(root);
    try { mkdirSync(owner, { mode: 0o700 }); }
    catch (e) { if (e.code !== "EEXIST") throw e; existing = true; }
  }
  if (existing) {
    // A completed atomic publish can be recovered if PP died before updating the resource.
    // An incomplete directory is retained instead of replacing it or re-reading changed edits.
    try {
      privateDir(owner);
      const manifest = JSON.parse(readRegular(owner, "prepared.json").bytes.toString("utf8"));
      if (Object.entries(intent).some(([key, val]) => manifest[key] !== val)) throw new Error();
      const ready = { path: capture.path, oid: manifest.oid, directory: manifest.directory };
      if (inheritDirty) {
        ready.proof = seedProof(manifest.expected);
        verifySeed({ ...w, seed: ready });
      } else verifyCapture(ready);
      if (ready.oid !== w.baseline && (!inheritDirty || git(ready.path, "show", "-s", "--format=%P", ready.oid).trim() !== w.baseline)) throw new Error();
      return ready;
    } catch { throw new Error("working-copy input preparation is incomplete or unverifiable; the original inputs are retained for inspection"); }
  }
  const stage = join(owner, "preparing");
  mkdirSync(stage, { mode: 0o700 });
  git(stage, "init", "--quiet", "--template=", `--object-format=${w.baseline.length === 40 ? "sha1" : "sha256"}`);
  fetchOid(stage, w.source, w.baseline);
  const entries = tree(stage, w.baseline);
  if (inheritDirty && git(w.source, "rev-parse", "HEAD").trim() !== w.baseline) throw new Error("dirty inheritance requires the source HEAD as its baseline");
  const { oid, expected } = inheritDirty ? seedTree(w, stage, entries) : { oid: w.baseline };
  // Populate an empty worktree from the final commit, as an independent restore
  // would. In particular, use the final committed attributes, not stale files.
  if (inheritDirty) git(stage, "read-tree", "--empty");
  git(stage, "checkout", "--quiet", "--detach", oid);
  if (inheritDirty) verifySeedBytes(stage, expected, seedRoundTrip);
  git(stage, "fsck", "--connectivity-only", "--no-reflogs", oid);
  const directory = privateDir(stage);
  verifyCapture({ path: stage, directory, oid });
  writeFileSync(join(owner, "prepared.json"), JSON.stringify({ ...intent, directory, oid, expected }), { mode: 0o600, flag: "wx", flush: true });
  renameSync(stage, capture.path);
  return { path: capture.path, directory, oid, ...(inheritDirty ? { proof: seedProof(expected) } : {}) };
}

function seedProof(expected) {
  if (!Array.isArray(expected) || expected.some((row) => !safePath(row?.file) ||
    !(row.mode === "0" ? row.sha256 === null : ["100644", "100755"].includes(row.mode) && /^[a-f0-9]{64}$/.test(row.sha256)))) {
    throw new Error("dirty seed has no verified byte manifest; start a new checkout explicitly");
  }
  return digest(JSON.stringify(expected));
}

export function verifySeed(w, checkout) {
  const seed = w.seed;
  const invalid = "dirty seed has no verified byte manifest; start a new checkout explicitly";
  if (!seed?.proof) throw new Error(invalid);
  let expected;
  try {
    const manifest = JSON.parse(readRegular(dirname(seed.path), "prepared.json").bytes.toString("utf8"));
    ({ expected } = manifest);
    if (manifest.nonce !== w.nonce || manifest.source !== w.source || manifest.baseline !== w.baseline || manifest.dirty !== true ||
        manifest.directory !== seed.directory || manifest.oid !== seed.oid || seedProof(expected) !== seed.proof) throw new Error();
  } catch { throw new Error(invalid); }
  verifyCapture(seed);
  verifySeedBytes(seed.path, expected, seedRoundTrip);
  if (checkout) verifySeedBytes(checkout, expected, `${seedRoundTrip} in the allocated checkout`);
}

export function importSeed(w) {
  verifySeed(w);
  fetchOid(w.source, w.seed.path, w.seed.oid);
}

export function verifyCapture(capture) {
  const { path, oid, directory } = capture;
  const gitDir = join(path, ".git"), config = join(gitDir, "config");
  const invalid = () => new Error("working-copy capture could not be verified as clean and independent");
  if (!directory || privateDir(path) !== directory || !lstatSync(gitDir).isDirectory() || !readRegular(gitDir, "config")) throw invalid();
  for (const file of ["objects/info/alternates", "objects/info/http-alternates", "commondir"]) {
    try { lstatSync(join(gitDir, file)); } catch (e) { if (e.code === "ENOENT") continue; throw invalid(); }
    throw invalid();
  }
  const keys = git(path, "config", "--file", config, "--no-includes", "--list", "--null").split("\0").filter(Boolean);
  if (keys.some((row) => !/^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|extensions\.objectformat)\n/.test(row))) throw invalid();
  if (git(path, "rev-parse", "--absolute-git-dir").trim() !== gitDir ||
      git(path, "rev-parse", "--verify", "HEAD").trim() !== oid ||
      git(path, "for-each-ref", "--format=%(objectname) %(refname)").trim().split("\n").some((ref) => ref && ref !== `${oid} refs/heads/pp-seed`) ||
      git(path, "diff", "--no-ext-diff", "--quiet", "HEAD", "--") || git(path, "ls-files", "--others", "-z")) throw invalid();
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const pins = (v) => object(v) && Object.keys(v).length > 0 && Object.entries(v).every(([file, hash]) =>
  safePath(file) && /^[a-f0-9]{64}$/.test(hash) && typeof hash === "string");
const cold = (reason) => ({ result: { state: "cold", reason } });

// `working-copy-cache.json` at Project root keys one recipe per canonical repo. Hashes pin the
// declared tracked inputs on both ends and each exact output; a Git ignore or directory name is
// not authorization. This is copy-only, not a rebuild hook or authorization to delete anything.
export function planCache(project, h, w, identity) {
  if (w.ovnfs?.from || w.ovnfs?.label || w.machine) return {};
  let declaration;
  try {
    const file = readRegular(realpathSync(project.path()), "working-copy-cache.json");
    if (!file) return {};
    const data = JSON.parse(file.bytes.toString("utf8"));
    if (!object(data)) return cold("invalid cache declaration");
    if (!Object.hasOwn(data, w.source)) return {};
    declaration = data[w.source];
  } catch { return cold("cache declaration could not be verified"); }
  const { baseline, root, inputs, files } = declaration ?? {};
  if (!object(declaration) || Object.keys(declaration).some((k) => !["baseline", "root", "inputs", "files"].includes(k)) ||
      !safePath(root) || root.includes("/") || !pins(inputs) || !pins(files) ||
      Object.keys(files).some((leaf) => localPath(`${root}/${leaf}`)) || Object.keys(inputs).some(localPath)) return cold("invalid or private cache declaration");
  if (baseline !== (w.seed?.oid ?? w.baseline)) return cold("cache input baseline changed");
  const start = identity.initial_oid ?? w.seed?.oid ?? w.baseline;
  if (start !== baseline) return cold("cache checkout input baseline changed");
  if (w.backend === "git-worktree") {
    try { requireCleanCheckout(h, w.path, start); }
    catch { return cold("Git checkout filter inputs could not be verified for cache reuse"); }
  }
  try {
    const entries = git(w.path, "ls-tree", "-r", "-z", start).split("\0").filter(Boolean);
    const tracked = new Set(entries.filter((entry) => /^100(?:644|755) blob /.test(entry)).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
    if (entries.some((entry) => entry.slice(entry.indexOf("\t") + 1).toLowerCase().split("/")[0] === root.toLowerCase())) return cold("cache root overlaps tracked content");
    for (const [file, hash] of Object.entries(inputs)) {
      const source = readRegular(w.source, file), target = readRegular(w.path, file);
      if (!tracked.has(file) || !source || !target || digest(source.bytes) !== hash || digest(target.bytes) !== hash) return cold("cache input content changed or could not be verified");
    }
    const destination = join(w.path, root);
    try { lstatSync(destination); return cold("cache destination already exists"); }
    catch (e) { if (e.code !== "ENOENT") return cold("cache destination could not be verified"); }
    const items = [];
    for (const [leaf, hash] of Object.entries(files)) {
      const name = `${root}/${leaf}`;
      for (const dir of [w.source, w.path]) git(dir, "check-ignore", "-q", "--", name);
      const item = readRegular(w.source, name);
      if (!item || digest(item.bytes) !== hash) return cold("declared cache content changed or could not be verified");
      items.push({ leaf, ...item });
    }
    return { destination, items, result: { state: "reused", baseline, root, files: items.length } };
  } catch { return cold("cache inputs, ignored paths or files could not be verified"); }
}

export function materializeCache({ destination, items }) {
  // mkdir itself exclusively claims the destination. Do not merge with or replace anything.
  // On interruption, the durable staging intent blocks launch; never assume a partial cache is valid.
  try {
    mkdirSync(destination, { mode: 0o700 });
    for (const { leaf, bytes, mode } of items) {
      const file = join(destination, leaf);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (realpathSync(dirname(file)) !== dirname(file)) throw new Error("cache destination aliases another path");
      writeFileSync(file, bytes, { flag: "wx", mode: mode === "100755" ? 0o700 : 0o600, flush: true });
    }
  } catch { throw new Error("cache write could not be verified; retain the original checkout and inspect its staging state"); }
}
