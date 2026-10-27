import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import { threadActionRpc, threadDetailRpc, inboxDoneRpc, inboxListRpc, tasksRpc, boardSectionRpc, boardActionRpc, boardEditRpc } from "../shared/tasks";

const run = promisify(execFile);

/**
 * This plugin's own folder, from Paseo's config: `import.meta.url` is undefined in the plugin
 * runtime, so the checkout cannot be found by walking up from this file.
 */
function pluginDir(): string {
  try {
    const plugins = JSON.parse(readFileSync(join(homedir(), ".paseo", "config.json"), "utf8")).plugins;
    const p = plugins?.["paseo-projects"]?.path;
    if (p) return p;
  } catch {}
  throw new Error("the paseo-projects plugin is not in ~/.paseo/config.json");
}

// Same order as `pp`: PP_ROOT, then config.json's root, then <repo>/projects.
function rootDir(): string {
  const repo = join(pluginDir(), "..");
  let configured: string | undefined;
  try { configured = JSON.parse(readFileSync(join(repo, "config.json"), "utf8")).root; } catch {}
  return process.env.PP_ROOT ?? configured ?? join(repo, "projects");
}

const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const isSlug = (s: string) => /^[a-z0-9][a-z0-9-]*$/.test(s);
const isThread = (s: string) => /^t-\d{4,}$/.test(s);

function projectDirs(root: string): Array<[string, string]> {
  try {
    return readdirSync(root)
      .filter((n) => isSlug(n) && existsSync(join(root, n, "PROJECT.md")))
      .filter((n) => readJson(join(root, n, ".state", "project.json"))?.status !== "archived")
      .map((n) => [n, join(root, n)] as [string, string]);
  } catch { return []; }
}

/** Runs `<pp> --root <root> <args...>`; an Electron daemon needs its own binary as node. */
function pp(root: string, ...args: string[]) {
  const node = process.versions.electron ? process.execPath : "node";
  // PP_ASK: a command only you may run asks you in a macOS dialog instead of refusing.
  const env = { ...process.env, PP_ASK: "dialog", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
  return run(node, [join(pluginDir(), "..", "bin", "pp.mjs"), "--root", root, ...args], { env, timeout: 120_000 });
}

/** What the daemon shows when a `pp` call fails: its error tail, not a stack. */
async function via(what: string, p: Promise<{ stdout: string }>): Promise<{ ok: boolean; message: string }> {
  try { return { ok: true, message: (await p).stdout.trim() }; }
  catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`${what}: ${String(err.stderr || err.message || e).split("\n").filter(Boolean).pop()}`);
  }
}

export function listTasks(_input: RpcInput<typeof tasksRpc>) {
  const root = rootDir();
  const threads: Array<{ project: string; id: string; title: string; group: string; profile: string; branch: string | null; pr: string | null; prState: string | null; updated: string }> = [];
  for (const [slug, dir] of projectDirs(root)) {
    let files: string[] = [];
    try { files = readdirSync(join(dir, "threads")).filter((n) => /^t-\d{4,}\.json$/.test(n)); } catch {}
    for (const f of files) {
      const t = readJson(join(dir, "threads", f));
      if (!t) continue;
      const group = t.status === "resolved" ? "resolved" : t.last_group || (t.status === "starting" ? "working" : "idle");
      threads.push({ project: slug, id: t.id, title: t.title, group, profile: t.profile ?? "", branch: t.branch || null, pr: t.pr || null, prState: t.pr_state || null, updated: t.updated ?? "" });
    }
  }
  threads.sort((a, b) => b.updated.localeCompare(a.updated));
  // shortcut: only the 20 latest resolved threads; `pp thread list --all` has the rest.
  let resolved = 0;
  return { root, threads: threads.filter((t) => t.group !== "resolved" || ++resolved <= 20) };
}

// The report's `## Next` lines, list markers removed (same rule as pp's `nextLines`).
function nextLines(report: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of report.split("\n")) {
    if (line.startsWith("## ")) { inside = line.trim() === "## Next"; continue; }
    if (line.startsWith("#")) { inside = false; continue; }
    if (!inside) continue;
    const t = line.trim().replace(/^(?:[-*] |\d+\. )/, "").trim();
    if (t) out.push(t);
  }
  return out;
}

export function threadDetail({ project, id }: RpcInput<typeof threadDetailRpc>) {
  if (!isSlug(project) || !isThread(id)) throw new Error("no such project or thread");
  const root = rootDir();
  const t = readJson(join(root, project, "threads", `${id}.json`));
  if (!t) throw new Error(`no thread ${id} in ${project}`);
  const report = (() => { try { return readFileSync(join(root, project, "threads", `${id}.md`), "utf8"); } catch { return "(no report yet)"; } })();
  return { report, next: nextLines(report), cwd: t.cwd ?? "", status: t.status ?? "" };
}

export async function threadAction({ project, id, action, line }: RpcInput<typeof threadActionRpc>) {
  if (!isSlug(project) || !isThread(id)) throw new Error("no such project or thread");
  const root = rootDir();
  switch (action) {
    case "ack": return via(`ack ${id}`, pp(root, "thread", "ack", project, id));
    case "restart": return via(`restart ${id}`, pp(root, "thread", "restart", project, id));
    case "resolve": return via(`resolve ${id}`, pp(root, "thread", "resolve", project, id));
    case "next": {
      if (!line) throw new Error("forwarding a Next line needs its number");
      return via(`next ${id} ${line}`, pp(root, "thread", "next", project, id, "--line", String(line)));
    }
  }
}

// An inbox item's front matter, read the same way as `inbox.unhandled` does.
type Item = { project: string; id: string; kind: string; subject: string; summary: string; created: string };
function parseItem(dir: string, name: string, project: string): Item | null {
  let text: string;
  try { text = readFileSync(join(dir, name), "utf8"); } catch { return null; }
  if (!text.startsWith("+++\n")) return null;
  const front = text.slice(4, text.indexOf("\n+++\n"));
  const field = (k: string) => (new RegExp(`^${k} = "(.*)"$`, "m").exec(front)?.[1] ?? "").replace(/\\"/g, '"');
  const id = name.replace(/\.md$/, "");
  return { project, id, kind: field("kind") || "", subject: field("subject") || "", summary: field("summary") || "", created: field("created") || "" };
}

export function listInbox(_input: RpcInput<typeof inboxListRpc>) {
  const root = rootDir();
  const items: Item[] = [];
  for (const [slug, dir] of projectDirs(root)) {
    let names: string[] = [];
    try { names = readdirSync(join(dir, "inbox")).filter((n) => n.endsWith(".md")); } catch {}
    for (const n of names) { const item = parseItem(join(dir, "inbox"), n, slug); if (item) items.push(item); }
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items };
}

export async function inboxDone({ project, ids }: RpcInput<typeof inboxDoneRpc>) {
  if (!isSlug(project) || !ids.every((i) => /^[\w.-]+$/.test(i))) throw new Error("no such project or item");
  return via("inbox done", pp(rootDir(), "inbox", "done", project, ...ids));
}

export async function boardSection({ section }: RpcInput<typeof boardSectionRpc>) {
  const { message } = await via(`board ${section}`, pp(rootDir(), "board", section));
  return { data: JSON.parse(message) };
}

const TASK_VERBS = { delegate: "Please delegate", done: "Please mark as done", drop: "Please drop" } as const;
export async function boardAction({ project, kind, action, target }: RpcInput<typeof boardActionRpc>) {
  if (!isSlug(project) || !target || target.length > 500) throw new Error("no such project or target");
  if (kind === "routine") {
    if (action !== "toggle" || !/^[\w.-]+$/.test(target)) throw new Error("a routine only toggles");
    return via(`toggle ${target}`, pp(rootDir(), "routine", "toggle", project, target));
  }
  if (action === "toggle") throw new Error("a task does not toggle");
  return via(`${action} task`, pp(rootDir(), "coordinator", "prompt", project, "--text", `(from the board) ${TASK_VERBS[action]} the task "${target}" in TASKS.md.`));
}

export async function boardEdit(edit: RpcInput<typeof boardEditRpc>) {
  return via(`${edit.scope} ${edit.key}`, pp(rootDir(), "board", "edit", JSON.stringify(edit)));
}
