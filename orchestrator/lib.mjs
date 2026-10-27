// Shared helpers: the Paseo client, git/sh, atomic files, the project lock,
// `+++` front matter with a small TOML subset, slugs.
import { createPaseoClient } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const log = (...a) => console.log(...a);
export const now = () => new Date().toISOString();
export const secondsSince = (stamp, at = Date.now()) => {
  const t = Date.parse(stamp ?? "");
  return Number.isNaN(t) ? 0 : Math.floor((at - t) / 1000);
};

const LOCAL_URL = "ws://127.0.0.1:6767/ws";
export function makeClient(url) {
  return createPaseoClient({ url: url || process.env.PASEO_URL || LOCAL_URL });
}

// One connected client per daemon URL for the life of the process.
const clients = new Map();
export async function client(url) {
  const key = url || process.env.PASEO_URL || LOCAL_URL;
  if (!clients.has(key)) {
    const c = makeClient(key);
    clients.set(key, c.connect().then(() => c, (e) => { clients.delete(key); throw e; }));
  }
  return clients.get(key);
}
export async function closeClients() {
  for (const p of clients.values()) await p.then((c) => c.close()).catch(() => {});
  clients.clear();
}

/**
 * A saved provider session (`claude`'s session id, …) as a new Paseo agent, then the profile's model, mode and title.
 * shortcut: the public client has no import, so this uses Paseo's internal daemon client; recheck on SDK upgrades.
 */
export async function importSession(url, { provider, sessionId, cwd, workspaceId, labels, model, modeId, title }) {
  if (provider === "claude" && !url) placeClaudeSession(sessionId, cwd);
  const d = new DaemonClient({ url: url || process.env.PASEO_URL || LOCAL_URL, clientId: `pp-import-${process.pid}-${Date.now()}`, clientType: "cli" });
  await d.connect();
  try {
    const agent = await d.importAgent({ provider, sessionId, cwd, workspaceId, labels });
    if (model) await d.setAgentModel(agent.id, model);
    if (modeId) await d.setAgentMode(agent.id, modeId);
    if (title) await d.updateAgent(agent.id, { name: title }).catch(() => {});
    return agent;
  } finally { await d.close().catch(() => {}); }
}

/** Claude Code's session folder for a working directory. */
export const claudeDir = (cwd, base = join(homedir(), ".claude", "projects")) => join(base, cwd.replace(/[^A-Za-z0-9]/g, "-"));

/**
 * Claude finds a session only in its cwd's folder, so one started in another folder (a herdr
 * pane's) is copied there first. The original is left as it is.
 */
export function placeClaudeSession(id, cwd, base = join(homedir(), ".claude", "projects")) {
  const to = claudeDir(cwd, base);
  if (existsSync(join(to, `${id}.jsonl`))) return;
  let dirs = [];
  try { dirs = readdirSync(base); } catch { return; }
  const from = dirs.map((d) => join(base, d)).find((d) => existsSync(join(d, `${id}.jsonl`)));
  if (!from) return;
  mkdirSync(to, { recursive: true });
  cpSync(join(from, `${id}.jsonl`), join(to, `${id}.jsonl`));
  if (existsSync(join(from, id))) cpSync(join(from, id), join(to, id), { recursive: true }); // subagent and tool-result files
}

export function sh(tokens, cwd, stdin, { timeout = 60_000, env } = {}) {
  const r = spawnSync(tokens[0], tokens.slice(1), { encoding: "utf8", cwd, input: stdin, timeout, env: env ? { ...process.env, ...env } : undefined });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, code: r.status, timedOut: r.error?.code === "ETIMEDOUT", stdout: r.stdout ?? "", stderr: r.stderr ?? "", out };
}

export function git(cwd, ...args) {
  const r = sh(["git", "-C", cwd, ...args], undefined, undefined, { timeout: 15_000 });
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.stdout.trim();
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
export function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
export const writeJson = (path, value) => writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// A mkdir lock: atomic on every filesystem. A holder that died leaves it to expire.
const LOCK_STALE_MS = 30_000;
export function withLock(dir, fn) {
  const lock = join(dir, ".lock");
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true }); } catch {}
      if (i > 500) throw new Error(`could not take the lock ${lock}`);
      spawnSync("sleep", ["0.02"]);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// ------------------------------------------------------------ front matter

/** `+++\n<toml>\n+++\n<body>` → { front, body }; null when there is none. */
export function splitFront(text) {
  if (!text.startsWith("+++\n")) return null;
  const rest = text.slice(4);
  const end = rest.indexOf("\n+++\n");
  if (end >= 0) return { front: rest.slice(0, end), body: rest.slice(end + 5) };
  if (rest.endsWith("\n+++")) return { front: rest.slice(0, -4), body: "" };
  return null;
}

function tomlValue(raw, where) {
  const v = raw.trim();
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (v === "true" || v === "false") return v === "true";
  if (/^[-+]?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]")).trim();
    if (!inner) return [];
    return splitTop(inner).filter((s) => s.trim()).map((s) => tomlValue(s, where));
  }
  if (v.startsWith("{")) {
    const out = {};
    for (const pair of splitTop(v.slice(1, v.lastIndexOf("}")))) {
      if (!pair.trim()) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`${where}: bad inline table`);
      out[pair.slice(0, eq).trim().replace(/^"|"$/g, "")] = tomlValue(pair.slice(eq + 1), where);
    }
    return out;
  }
  if (v.startsWith('"')) return JSON.parse(v);
  throw new Error(`${where}: unsupported value \`${v}\``);
}

// Splits on top-level commas, outside strings and brackets.
function splitTop(text) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

// Strips a `#` comment that is outside a string.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

const balance = (s) => [...s].reduce((n, c) => n + (c === "[" || c === "{" ? 1 : c === "]" || c === "}" ? -1 : 0), 0);

/**
 * The TOML subset front matter uses: `key = value` with strings, integers,
 * booleans, arrays (may span lines) and inline tables, `[a."b"]` tables and
 * `[[name]]` arrays of tables. shortcut: no dotted keys on the left of `=`,
 * dates or multi-line strings; swap in a
 * real TOML parser if front matter ever needs them.
 */
export function parseToml(text, where = "front matter") {
  const out = {};
  let target = out;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    const table = line.match(/^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]$/);
    if (table) {
      (out[table[1]] ??= []).push((target = {}));
      continue;
    }
    const header = line.match(/^\[([^[\]]+)\]$/);
    if (header) {
      target = out;
      for (const m of header[1].matchAll(/"([^"]*)"|([A-Za-z0-9_-]+)/g)) target = (target[m[1] ?? m[2]] ??= {});
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`${where}: line ${i + 1} is not \`key = value\``);
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    let value = line.slice(eq + 1);
    while (balance(value) > 0 && i + 1 < lines.length) value += " " + stripComment(lines[++i]).trim();
    target[key] = tomlValue(value, `${where}: \`${key}\``);
  }
  return out;
}

const tomlString = (s) => JSON.stringify(String(s));
export function tomlLine(key, value) {
  const enc = (v) => Array.isArray(v) ? `[${v.map(enc).join(", ")}]`
    : typeof v === "object" && v ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${enc(x)}`).join(", ")} }`
    : typeof v === "string" ? tomlString(v) : String(v);
  return `${key} = ${enc(value)}`;
}

// ------------------------------------------------------------ names

export function validateSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? "") || slug.length > 40) {
    throw new Error(`\`${slug}\` is not a valid slug: lower-case letters, digits and \`-\`, starting with a letter or digit, at most 40 characters`);
  }
}
export function slugify(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}
export const humanize = (slug) => slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/**
 * Asks a person at a terminal; refuses when standard input is not one. With PP_ASK=dialog (the board sets it)
 * a macOS dialog naming the exact command asks instead: an agent setting PP_ASK only raises a dialog you answer.
 */
export function requirePerson(what) {
  if (process.stdin.isTTY) return;
  if (process.env.PP_ASK === "dialog" && process.platform === "darwin") {
    const text = `Allow this change?\n\npp ${process.argv.slice(2).filter((a, i, all) => a !== "--root" && all[i - 1] !== "--root").join(" ")}`;
    const r = spawnSync("osascript", ["-e", "on run argv", "-e",
      'display dialog (item 1 of argv) with title "paseo-projects" buttons {"Cancel", "Allow"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 100',
      "-e", "end run", text], { encoding: "utf8" });
    if (r.status === 0 && /button returned:Allow/.test(r.stdout) && !/gave up:true/.test(r.stdout)) return;
    throw new Error(`${what} was not allowed in the dialog`);
  }
  throw new Error(`${what} must be run by a person at a terminal; standard input is not a terminal`);
}
export function ask(question) {
  process.stdout.write(question);
  const r = spawnSync("sh", ["-c", "read line && printf %s \"$line\""], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
  return (r.stdout ?? "").trim();
}
