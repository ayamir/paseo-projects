// The user's config.json: projects root, profiles, defaults, safety tables,
// machines. Only a person edits it; agents only ever name a profile.
//
// {
//   "root": "/abs/projects",                       // default: <repo>/projects
//   "profiles": { "sonnet": { "provider": "claude/claude-sonnet-5-5", "mode": "auto",
//                             "thinking": "high", "yolo_mode": "bypassPermissions",
//                             "description": "…" } },
//   "defaults": { "thread_profile": "sonnet", "coordinator_profile": "opus" },
//   "safety": { "default": { … }, "/canonical/project/path": { … } },
//   "machines": { "m1": { "url": "ws://m1:6767/ws", "ssh": "user@m1", "profiles": ["sonnet"] } }
// }
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, readJson, writeJson, now, sha256 } from "./lib.mjs";

export const CONFIG_PATH = process.env.PP_CONFIG ?? join(REPO, "config.json");
export const APPROVALS_PATH = join(REPO, "approved-routines.json");

// Every Paseo provider is also a built-in profile of the same name.
export const BUILTINS = ["claude", "codex", "pi", "opencode", "gemini", "copilot", "cursor"];
// The mode that skips permission prompts, per provider (yolo).
const YOLO_MODES = { claude: "bypassPermissions" };

export function loadConfig() {
  const c = readJson(CONFIG_PATH, {}) ?? {};
  return { profiles: c.profiles ?? {}, defaults: c.defaults ?? {}, safety: c.safety ?? {}, machines: c.machines ?? {}, root: c.root };
}

export function defaultRoot() {
  const r = process.env.PP_ROOT ?? loadConfig().root ?? join(REPO, "projects");
  return r.startsWith("~/") ? join(homedir(), r.slice(2)) : r;
}

export const validateProfileName = (n) => {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(n ?? "")) throw new Error(`\`${n}\` is not a profile name (letters, digits, \`.\`, \`_\`, \`-\`)`);
};

/** A profile by name: the user's, else the built-in provider of that name. */
export function getProfile(config, name) {
  const p = config.profiles[name];
  if (p) return { name, provider: p.provider ?? name, mode: p.mode ?? "", thinking: p.thinking ?? "", yolo_mode: p.yolo_mode ?? "", description: p.description ?? "" };
  if (BUILTINS.includes(name)) return { name, provider: name, mode: "", thinking: "", yolo_mode: "", description: "" };
  return null;
}
export const kindOf = (profile) => profile.provider.split("/")[0];
export const modelOf = (profile) => profile.provider.split("/").slice(1).join("/");

/** `claude/claude-opus-5-5 · mode auto · thinking high — Hard work`. */
export function profileSummary(p) {
  const parts = [p.provider];
  if (p.mode) parts.push(`mode ${p.mode}`);
  if (p.thinking) parts.push(`thinking ${p.thinking}`);
  return parts.join(" · ") + (p.description ? ` — ${p.description}` : "");
}

// ------------------------------------------------------------ safety

const BUILTIN_SAFETY = { yolo: false, start_threads: "propose", routine_commands: false, thread_profiles: null, coordinator_profiles: null };
export const SAFETY_KEYS = {
  yolo: "on/off: threads and coordinators skip permission prompts",
  start_threads: "propose/auto: whether the coordinator waits for a go-ahead",
  routine_commands: "on/off: approved routine commands may run",
  thread_profiles: "profile names threads may use (empty: any)",
  coordinator_profiles: "profile names coordinators may use (empty: any)",
};

export function canonical(dir) {
  try { return realpathSync(dir); } catch { return dir; }
}

/** Own table over `default` over built-in; yolo forces start_threads=auto. */
export function loadSafety(config, projectDir) {
  const own = config.safety[canonical(projectDir)] ?? {};
  const def = config.safety.default ?? {};
  const out = {};
  const source = {};
  for (const key of Object.keys(BUILTIN_SAFETY)) {
    if (key in own) { out[key] = own[key]; source[key] = "project"; }
    else if (key in def) { out[key] = def[key]; source[key] = "all projects"; }
    else { out[key] = BUILTIN_SAFETY[key]; source[key] = "built-in"; }
  }
  if (out.yolo) out.start_threads = "auto";
  return { ...out, source };
}

export function setSafety(target, key, value) {
  if (!(key in SAFETY_KEYS)) throw new Error(`\`${key}\` is not a safety key: ${Object.keys(SAFETY_KEYS).join(", ")}`);
  const raw = readJson(CONFIG_PATH, {}) ?? {};
  raw.safety ??= {};
  const table = (raw.safety[target] ??= {});
  if (value === undefined) delete table[key]; else table[key] = value;
  if (!Object.keys(table).length) delete raw.safety[target];
  writeJson(CONFIG_PATH, raw);
}

export function parseSafetyValue(key, words) {
  if (words.length === 1 && words[0] === "default") return undefined;
  if (key === "yolo" || key === "routine_commands") {
    const w = words[0];
    if (!["on", "off", "true", "false"].includes(w)) throw new Error(`${key} takes on or off`);
    return w === "on" || w === "true";
  }
  if (key === "start_threads") {
    if (!["propose", "auto"].includes(words[0])) throw new Error("start_threads takes propose or auto");
    return words[0];
  }
  const names = words.flatMap((w) => w.split(",")).map((w) => w.trim()).filter(Boolean);
  names.forEach(validateProfileName);
  return names;
}

// ------------------------------------------------------------ roles

export const ROLES = {
  thread: { list: "thread_profiles", def: "thread_profile" },
  coordinator: { list: "coordinator_profiles", def: "coordinator_profile" },
};

export function allowed(safety, role) {
  const list = safety[ROLES[role].list];
  return Array.isArray(list) && list.length ? list : null;
}

/** The profile `role` launches with: `requested`, else the project's default. */
export function resolveProfile(config, safety, settings, role, requested, slug) {
  const name = requested || settings[ROLES[role].def] || config.defaults[ROLES[role].def] || "claude";
  validateProfileName(name);
  const profile = getProfile(config, name);
  if (!profile) throw new Error(`no profile \`${name}\`; profiles: ${listedNames(config).join(", ")}`);
  const list = allowed(safety, role);
  if (list && !list.includes(name)) throw new Error(`profile \`${name}\` is not allowed for ${role}s in \`${slug}\`; allowed: ${list.join(", ")}`);
  return profile;
}

export const listedNames = (config) => [...new Set([...Object.keys(config.profiles), ...BUILTINS])];

/** Profiles `role` may use in a project, the user's first. */
export function usable(config, safety, role) {
  const list = allowed(safety, role);
  const names = list ?? Object.keys(config.profiles);
  return names.map((n) => getProfile(config, n)).filter(Boolean);
}

/** The Paseo agent config a profile launches with. */
export function agentConfig(profile, safety, extra = {}) {
  const cfg = { provider: profile.provider, ...extra };
  const yolo = safety.yolo ? profile.yolo_mode || YOLO_MODES[kindOf(profile)] : "";
  if (yolo || profile.mode) cfg.modeId = yolo || profile.mode;
  if (profile.thinking) cfg.thinkingOptionId = profile.thinking;
  return cfg;
}
export const yoloKnown = (profile) => Boolean(profile.yolo_mode || YOLO_MODES[kindOf(profile)]);

// ------------------------------------------------------------ editing profiles (the user's alone)

/** Reads config.json raw, lets `fn` change it, writes it back atomically. */
export function editConfig(fn) {
  const raw = readJson(CONFIG_PATH, {}) ?? {};
  fn(raw);
  writeJson(CONFIG_PATH, raw);
}

/** Where config.json names a profile: the defaults and the allow-lists. */
export function profileUses(raw, name) {
  const uses = [];
  for (const r of Object.values(ROLES)) if (raw.defaults?.[r.def] === name) uses.push(`defaults.${r.def}`);
  for (const [table, s] of Object.entries(raw.safety ?? {}))
    for (const r of Object.values(ROLES)) if (s[r.list]?.includes(name)) uses.push(`safety ${table} ${r.list}`);
  return uses;
}

/** `add`, `edit` or `remove` a profile on the raw config object; an empty field value clears it. */
export function changeProfile(raw, op, name, fields = {}) {
  validateProfileName(name);
  raw.profiles ??= {};
  const has = Object.hasOwn(raw.profiles, name);
  if (op === "add" && has) throw new Error(`profile \`${name}\` exists; \`pp profile edit\` changes it`);
  if (op !== "add" && !has) throw new Error(`no profile \`${name}\` of yours${BUILTINS.includes(name) ? " (built-ins cannot be changed; add one of the same name to override it)" : ""}`);
  if (op === "remove") {
    const uses = profileUses(raw, name);
    if (uses.length) throw new Error(`profile \`${name}\` is still named in ${uses.join(", ")}`);
    delete raw.profiles[name];
    return raw;
  }
  const p = { ...(raw.profiles[name] ?? {}) };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) { if (v === "") delete p[k]; else p[k] = v; }
  if (!/^[a-z0-9-]+(\/\S+)?$/.test(p.provider ?? "")) throw new Error("a profile needs --provider KIND[/MODEL], such as claude/claude-opus-5-5");
  raw.profiles[name] = p;
  return raw;
}

// ------------------------------------------------------------ machines

export function machine(config, name) {
  const m = config.machines[name];
  if (!m) throw new Error(`no machine \`${name}\` in ${CONFIG_PATH} (machines: ${Object.keys(config.machines).join(", ") || "none"})`);
  return { name, url: m.url ?? "", ssh: m.ssh ?? "", profiles: m.profiles ?? [] };
}

// ------------------------------------------------------------ routine approvals

export const approvals = () => readJson(APPROVALS_PATH, []) ?? [];

/** Approved: this canonical project path, routine name and the command's current hash. */
export function isApproved(projectDir, name, command) {
  const path = canonical(projectDir);
  const hash = sha256(command);
  return approvals().some((a) => a.project === path && a.routine === name && a.command_sha256 === hash);
}
export function storeApproval(projectDir, name, command) {
  const path = canonical(projectDir);
  const all = approvals().filter((a) => !(a.project === path && a.routine === name));
  all.push({ project: path, routine: name, command_sha256: sha256(command), approved: now() });
  writeJson(APPROVALS_PATH, all);
}
export function moveApprovals(oldPath, newPath) {
  const all = approvals();
  const moving = all.filter((a) => a.project === oldPath).map((a) => a.routine);
  const kept = all.filter((a) => !(a.project === newPath && moving.includes(a.routine)));
  for (const a of kept) if (a.project === oldPath) a.project = newPath;
  writeJson(APPROVALS_PATH, kept);
}
