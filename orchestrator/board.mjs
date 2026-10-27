// What the board plugin's tasks, routines, settings and memory tabs show: `pp board <section>`
// prints it as JSON, the same data `context` and `routine list` read. Archived projects are left out.
import { readdirSync } from "node:fs";
import { readText } from "./lib.mjs";
import { loadConfig, loadSafety, listedNames, getProfile, profileSummary, SAFETY_KEYS } from "./config.mjs";
import { Project, listSlugs, SET_KEYS } from "./project.mjs";
import { readTickerState } from "./coordinator.mjs";
import * as tasks from "./tasks.mjs";
import * as routines from "./routines.mjs";

export const SECTIONS = ["tasks", "routines", "settings", "memory"];
const SETTING_KEYS = ["name", "goal", "coordinator_profile", "thread_profile", "max_parallel_threads", "auto_resolve_days", "nudge", "mute"];

export function boardData(root, section) {
  if (!SECTIONS.includes(section)) throw new Error(`usage: pp board ${SECTIONS.join("|")}`);
  const projects = listSlugs(root).map((s) => new Project(root, s)).filter((p) => p.status !== "archived");
  if (section === "tasks") {
    return projects.flatMap((p) => tasks.parse(readText(p.path("TASKS.md"))).map((t) => ({
      project: p.slug, list: t.list, title: t.title, owner: tasks.ownerText(t.owner), thread: t.thread ?? "", notes: t.description.trim(),
    })));
  }
  if (section === "routines") {
    return projects.flatMap((p) => {
      const state = readTickerState(p).routines ?? {};
      const { routines: list, broken } = routines.loadAll(p);
      return [
        ...list.map((r) => ({ project: p.slug, name: r.name, when: r.scheduleText, enabled: r.enabled, command: r.command, last: routines.whenText(r, state[r.name]), prompt: r.prompt, error: "" })),
        ...broken.map((b) => ({ project: p.slug, name: b.file, when: "", enabled: false, command: "", last: "", prompt: "", error: b.error })),
      ];
    });
  }
  if (section === "settings") {
    const config = loadConfig();
    return {
      profiles: listedNames(config).map((n) => ({ ...getProfile(config, n), summary: profileSummary(getProfile(config, n)), builtin: !config.profiles[n] })),
      defaults: config.defaults,
      hints: SET_KEYS,
      projects: projects.map((p) => {
        const { settings } = p.readLenient();
        const safety = loadSafety(config, p.dir);
        return {
          project: p.slug, status: p.status,
          settings: Object.fromEntries([...SETTING_KEYS.map((k) => [k, settings[k]]), ["repos", (settings.repos ?? []).map((r) => r.path + (r.machine ? `@${r.machine}` : ""))]]),
          safety: Object.fromEntries(Object.keys(SAFETY_KEYS).map((k) => [k, { value: safety[k], source: safety.source[k], hint: SAFETY_KEYS[k] }])),
        };
      }),
    };
  }
  return projects.flatMap((p) => {
    let names = [];
    try { names = readdirSync(p.path("memory")).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort(); } catch {}
    return [["MEMORY.md", p.path("MEMORY.md")], ...names.map((n) => [`memory/${n}`, p.path("memory", n)])]
      .map(([file, path]) => ({ project: p.slug, file, text: readText(path) }));
  });
}

const PROFILE_FIELDS = ["provider", "mode", "thinking", "yolo_mode", "description"];
const NAME = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * A board edit as the `pp` command it runs: `project` is `pp set`, the rest are the user's own
 * commands, which ask through requirePerson. Values go inline (`--k=v`) or last, so none reads as a flag.
 */
export function editArgs({ scope, target, key, value = "" }) {
  const bad = (why) => { throw new Error(`board edit: ${why}`); };
  if (!NAME.test(target ?? "")) bad(`\`${target}\` is not a project, profile or role`);
  if (typeof value !== "string" || value.length > 2000) bad("the value is not text");
  if (scope === "project") {
    if (!(key in SET_KEYS)) bad(`\`${key}\` is not a setting`);
    if (value.startsWith("-")) bad("a setting cannot start with -");
    return ["set", target, key, value];
  }
  if (scope === "safety") {
    if (!(key in SAFETY_KEYS)) bad(`\`${key}\` is not a safety key`);
    const words = value.split(/[\s,]+/).filter(Boolean);
    if (words.some((w) => w.startsWith("-"))) bad("a safety value cannot start with -");
    return ["safety", "set", target, key, ...words];
  }
  if (scope === "profile") {
    if (key === "remove") return ["profile", "remove", target];
    if (key === "add") return ["profile", "add", target, `--provider=${value}`];
    if (!PROFILE_FIELDS.includes(key)) bad(`\`${key}\` is not a profile field`);
    return ["profile", "edit", target, `--${key.replace("_", "-")}=${value}`];
  }
  if (scope === "default") {
    if (target !== "thread" && target !== "coordinator") bad("a default is for thread or coordinator");
    if (!NAME.test(value)) bad(`\`${value}\` is not a profile name`);
    return ["profile", "default", target, value];
  }
  return bad(`\`${scope}\` is not a scope`);
}
