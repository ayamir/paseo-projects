// A project is a folder under the root: PROJECT.md (settings + instructions),
// AGENTS.md/CLAUDE.md (who is who), MEMORY.md, memory/, TASKS.md, routines/,
// threads/, inbox/, library/, uploads/, scratch/, .state/.
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO, readText, readJson, writeJson, writeAtomic, withLock, splitFront, parseToml, tomlLine, validateSlug, humanize, sha256, now, isFile } from "./lib.mjs";
import { defaultRoot, loadConfig } from "./config.mjs";

export const SUBDIRS = ["memory", "scratch", "routines", "threads", "inbox", "inbox/done", "library", "uploads", ".state"];
export const TASKS_TEMPLATE = "# Tasks\n\n## Backlog\n";
const MEMORY_TEMPLATE = "# Memory\n\nOne line per memory file: `- [title](memory/file.md): what it holds`.\n";
const INSTRUCTIONS_TEMPLATE = `# Instructions

Standing instructions for this project. Every thread starts from this text and
from the project's memory. Replace this paragraph with how you want work done:
conventions, what to check before finishing, what never to do. Ask the
coordinator to change it, or edit it here.

The settings above, between the \`+++\` lines, are changed with \`pp set\` or by
asking the coordinator.
`;
const PR_FOLLOWUP_TEMPLATE = '+++\non = "pr"\nevents = ["checks-failed", "review"]\nenabled = true\n+++\n\nFix the failing checks and address the new review comments on your pull request. Read them with `gh`, push the fixes, reply where a reviewer asked something, and then rewrite your report. If a comment asks for something outside your task, say so in the report instead of doing it.\n';

export const DEFAULT_SETTINGS = { name: "", goal: "", repos: [], coordinator_profile: "", thread_profile: "", max_parallel_threads: 10, auto_resolve_days: 7, nudge: true, mute: false, pr_checks: true };

export function rootOf(opts = {}) {
  return resolve(opts.root ?? defaultRoot());
}

/** `<pp> --root <root>`: the command every agent runs. */
export function prefix(root) {
  const q = (s) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
  return `${q(join(REPO, "bin", "pp.mjs"))} --root ${q(root)}`;
}

export class Project {
  constructor(root, slug) {
    validateSlug(slug);
    this.root = root;
    this.slug = slug;
    this.dir = join(root, slug);
  }
  static open(root, slug) {
    const p = new Project(root, slug);
    if (!isFile(join(p.dir, "PROJECT.md"))) throw new Error(`no project \`${slug}\` in ${root} (\`pp list\` shows them)`);
    return p;
  }
  path(...parts) { return join(this.dir, ...parts); }
  get stateDir() { return this.path(".state"); }
  lock(fn) { return withLock(this.stateDir, fn); }

  /** { settings, instructions }; throws when PROJECT.md does not parse. */
  read() {
    const text = readText(this.path("PROJECT.md"));
    const split = splitFront(text);
    if (!split) throw new Error(`${this.path("PROJECT.md")} has no \`+++\` front matter`);
    const front = parseToml(split.front, "PROJECT.md");
    const settings = { ...DEFAULT_SETTINGS, ...front };
    settings.repos = (front.repos ?? []).map((r) => (typeof r === "string" ? parseRepoArg(r) : { path: r.path, machine: r.machine || null }));
    return { settings, instructions: split.body.trim() };
  }
  settings() { return this.read().settings; }
  /** The settings, or defaults plus the error, for callers that must go on. */
  readLenient() {
    try { return { ...this.read(), error: null }; }
    catch (e) { return { settings: { ...DEFAULT_SETTINGS }, instructions: "", error: e.message, hash: sha256(readText(this.path("PROJECT.md"))) }; }
  }
  displayName(settings = this.readLenient().settings) { return settings.name?.trim() || humanize(this.slug); }

  state() { return { status: "active", former_slugs: [], ...readJson(this.path(".state", "project.json"), {}) }; }
  setState(change) { this.lock(() => writeJson(this.path(".state", "project.json"), { ...this.state(), ...change })); }
  get status() { return this.state().status; }

  coordinator() { return readJson(this.path(".state", "coordinator.json"), null); }
  setCoordinator(record) { this.lock(() => writeJson(this.path(".state", "coordinator.json"), record)); }
}

export function parseRepoArg(text) {
  const at = text.lastIndexOf("@");
  if (at > 0 && !text.slice(at + 1).includes("/")) return { path: text.slice(0, at), machine: text.slice(at + 1) };
  return { path: text, machine: null };
}

export function listSlugs(root) {
  try {
    return readdirSync(root).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n) && isFile(join(root, n, "PROJECT.md"))).sort();
  } catch { return []; }
}

export function agentsMd(name, slug, pfx) {
  return `# ${name}\n\nThis folder is the home of the paseo-projects project "${name}" (\`${slug}\`). Written by paseo-projects; \`doctor --fix\` refreshes it.\n\nIf your working directory is exactly this folder, you are the coordinator of ${name}: run \`${pfx} skill\` now and follow what it prints, and run \`${pfx} context ${slug}\` now and whenever you need project state.\n\nIf your working directory is under \`threads/\`, you are a thread: your brief is in your own folder (\`.paseo-project/${slug}-<id>/brief.md\`); ignore the rest of this file.\n`;
}

/** Writes AGENTS.md and the CLAUDE.md link to it. */
export function writeAgentsMd(project) {
  const { settings } = project.readLenient();
  writeAtomic(project.path("AGENTS.md"), agentsMd(project.displayName(settings), project.slug, prefix(project.root)));
  const link = project.path("CLAUDE.md");
  try { if (lstatSync(link)) unlinkSync(link); } catch {}
  symlinkSync("AGENTS.md", link);
  // A Claude coordinator runs its own `pp` commands and edits its files unasked; user-only commands refuse without a terminal anyway.
  mkdirSync(project.path(".claude"), { recursive: true });
  writeJson(project.path(".claude", "settings.json"), { permissions: { allow: [`Bash(${prefix(project.root)}:*)`, `Edit(/${project.dir}/**)`] } });
}

export function frontMatter(settings) {
  const lines = ["name", "goal", "coordinator_profile", "thread_profile", "max_parallel_threads", "auto_resolve_days", "nudge", "mute", "pr_checks"].map((k) => tomlLine(k, settings[k] ?? DEFAULT_SETTINGS[k]));
  for (const r of settings.repos ?? []) {
    lines.push("", "[[repos]]", tomlLine("path", r.path));
    if (r.machine) lines.push(tomlLine("machine", r.machine));
  }
  return lines.join("\n") + "\n";
}

/** `new`: every folder and file; PROJECT.md last, so a half-made folder is no project. */
export function create(root, slug, { name = "", goal = "", repos = [], threadProfile, coordinatorProfile } = {}) {
  validateSlug(slug);
  const dir = join(root, slug);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  const config = loadConfig();
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  const project = new Project(root, slug);
  writeFileSync(project.path("TASKS.md"), TASKS_TEMPLATE);
  writeFileSync(project.path("MEMORY.md"), MEMORY_TEMPLATE);
  writeFileSync(project.path("routines", "pr-followup.md"), PR_FOLLOWUP_TEMPLATE);
  writeJson(project.path(".state", "project.json"), { status: "active", former_slugs: [], created: now() });
  const settings = {
    ...DEFAULT_SETTINGS, name, goal, repos,
    thread_profile: threadProfile || config.defaults.thread_profile || "claude",
    coordinator_profile: coordinatorProfile || config.defaults.coordinator_profile || "claude",
  };
  writeFileSync(project.path("PROJECT.md"), `+++\n${frontMatter(settings)}+++\n\n${INSTRUCTIONS_TEMPLATE}`);
  writeAgentsMd(project);
  return project;
}

/** Replaces PROJECT.md's front matter, keeping the instructions as written. */
export function writeSettings(project, settings) {
  const text = readText(project.path("PROJECT.md"));
  const split = splitFront(text);
  const body = split ? split.body : text;
  project.lock(() => writeAtomic(project.path("PROJECT.md"), `+++\n${frontMatter(settings)}+++\n${body.startsWith("\n") ? "" : "\n"}${body}`));
}

// `set <slug> <key> <value>`.
export const SET_KEYS = {
  name: "text", goal: "text", coordinator_profile: "profile name", thread_profile: "profile name",
  max_parallel_threads: "number", auto_resolve_days: "number (0 = never)", nudge: "true/false", mute: "true/false",
  pr_checks: "true/false (false: CI check results are ignored: no inbox item, notification or checks-failed routine)",
  "repos.add": "PATH or PATH@MACHINE", "repos.remove": "PATH",
};
export function applySetting(settings, key, value) {
  const s = { ...settings, repos: [...settings.repos] };
  const bool = (v) => { if (v !== "true" && v !== "false") throw new Error(`${key} takes true or false`); return v === "true"; };
  const num = (v) => { if (!/^\d+$/.test(v)) throw new Error(`${key} takes a whole number`); return Number(v); };
  switch (key) {
    case "name": case "goal": case "coordinator_profile": case "thread_profile": s[key] = value; break;
    case "max_parallel_threads": s[key] = Math.max(1, num(value)); break;
    case "auto_resolve_days": s[key] = num(value); break;
    case "nudge": case "mute": case "pr_checks": s[key] = bool(value); break;
    case "repos.add": {
      const r = parseRepoArg(value);
      if (!r.path.startsWith("/")) throw new Error("a repo path must be absolute");
      if (s.repos.some((x) => x.path === r.path && (x.machine ?? null) === r.machine)) throw new Error(`${value} is already a repo`);
      s.repos.push(r);
      break;
    }
    case "repos.remove": {
      const before = s.repos.length;
      s.repos = s.repos.filter((x) => x.path !== value);
      if (s.repos.length === before) throw new Error(`${value} is not one of the repos`);
      break;
    }
    default: throw new Error(`\`${key}\` is not a setting: ${Object.keys(SET_KEYS).join(", ")}`);
  }
  return s;
}
