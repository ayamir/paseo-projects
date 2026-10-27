// Threads: one Paseo agent each, on its own worktree (or a folder, or the
// repo's checkout). Records in threads/<id>.json; the agent works from
// <cwd>/.paseo-project/<slug>-<id>/ (brief.md, report.md, library/).
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REPO, client, importSession, sh, now, readText, readJson, writeJson, writeAtomic, sha256, secondsSince, slugify, claudeDir } from "./lib.mjs";
import { loadConfig, loadSafety, resolveProfile, agentConfig, kindOf, modelOf, canonical, machine as machineOf } from "./config.mjs";
import { prefix } from "./project.mjs";
import * as inbox from "./inbox.mjs";


export const STARTING_TIMEOUT_SECS = 300;
export const BLOCKED_DEBOUNCE_SECS = 30;
export const MEMORY_CAP_CHARS = 32_000;
export const LIBRARY_CAP_KB = 50 * 1024;
export const ACTIVITY_TTL_SECS = 300;
export const WAITING = "Waiting for you";
const THREAD_MD = join(REPO, "skill", "THREAD.md");

// ------------------------------------------------------------ hosts

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Where a thread's files live: this machine, or a saved machine over ssh. */
export function host(machineName, config = loadConfig()) {
  const m = machineName ? machineOf(config, machineName) : null;
  if (m && !m.ssh) throw new Error(`machine \`${m.name}\` has no \`ssh\` target in config.json; its files cannot be reached`);
  const shell = (script, cwd, stdin, timeout) => {
    const full = cwd ? `cd ${q(cwd)} && ${script}` : script;
    return m ? sh(["ssh", "-o", "BatchMode=yes", m.ssh, full], undefined, stdin, { timeout }) : sh(["sh", "-c", full], undefined, stdin, { timeout });
  };
  return {
    remote: Boolean(m), name: m?.name ?? "", url: m?.url || undefined, ssh: m?.ssh ?? "", shell,
    /** A regular file's text (never through a symbolic link), or null. */
    read(path) { const r = shell(`[ -f ${q(path)} ] && [ ! -L ${q(path)} ] && cat -- ${q(path)}`); return r.ok ? r.stdout : null; },
    write(path, text) { const r = shell(`mkdir -p ${q(dirname(path))} && cat > ${q(path)}`, undefined, text); if (!r.ok) throw new Error(`could not write ${path}: ${r.out}`); },
    isDir(path) { return shell(`[ -d ${q(path)} ] && [ ! -L ${q(path)} ]`).ok; },
  };
}

// ------------------------------------------------------------ records

export const validateId = (id) => { if (!/^t-\d{4,}$/.test(id ?? "")) throw new Error(`\`${id}\` is not a thread id (expected the form t-0001)`); };
const recordPath = (p, id) => p.path("threads", `${id}.json`);
export const taskPath = (p, id) => p.path("threads", `${id}.task.md`);
export const homeReportPath = (p, id) => p.path("threads", `${id}.md`);
const extraNextPath = (p, id) => p.path("threads", `${id}.next.md`);
const progressPath = (p, id) => p.path("threads", `${id}.progress.json`);

export function load(project, id) {
  validateId(id);
  const t = readJson(recordPath(project, id));
  if (!t) throw new Error(`no thread \`${id}\` in \`${project.slug}\``);
  return t;
}

export function list(project) {
  let names = [];
  try { names = readdirSync(project.path("threads")); } catch {}
  return names.filter((n) => /^t-\d{4,}\.json$/.test(n)).map((n) => readJson(project.path("threads", n))).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

/** Read-modify-write under the project lock. */
export function update(project, id, change) {
  return project.lock(() => {
    const t = load(project, id);
    change(t);
    t.updated = now();
    writeJson(recordPath(project, id), t);
    return t;
  });
}

function allocate(project, fill) {
  return project.lock(() => {
    const next = Math.max(0, ...list(project).map((t) => Number(t.id.slice(2)))) + 1;
    const t = {
      id: `t-${String(next).padStart(4, "0")}`, title: "", status: "starting", error: "", kind: "worktree",
      repo: "", origin: "", branch: "", base: "", machine: "", cwd: "", thread_dir: "", agent_id: "", workspace_id: "",
      profile: "", provider: "", created: now(), updated: now(), last_state: "", last_state_change: "", last_group: "",
      report_hash: "", last_report_change: "", last_review_item_hash: "", acked_report_hash: "",
      pr: "", pr_state: "", pr_review: "", resolved_reason: "", kept_worktree: false, session: null,
    };
    fill(t);
    if (existsSync(recordPath(project, t.id))) throw new Error(`thread id ${t.id} is already taken`);
    writeJson(recordPath(project, t.id), t);
    return t;
  });
}

// Paseo turns `/` in a new branch name into `-`, so the name has none.
export function branchName(slug, id, title) {
  const s = slugify(title);
  return s ? `pp-${slug}-${id}-${s}` : `pp-${slug}-${id}`;
}
export const isOwnBranch = (slug, branch) => new RegExp(`^pp-${slug}-t-\\d{4,}(-|$)`).test(branch ?? "");
export const threadDir = (cwd, slug, id) => `${cwd.replace(/\/+$/, "")}/.paseo-project/${slug}-${id}`;
export const launchPrompt = (slug, id) => `Read .paseo-project/${slug}-${id}/brief.md and do what it says.`;

/** Appends a forwarded prompt under `## Follow-ups`, so a restarted thread re-reads it. */
export function appendFollowUp(project, id, text) {
  project.lock(() => {
    let task = readText(taskPath(project, id));
    if (task && !task.endsWith("\n")) task += "\n";
    if (!task.split("\n").some((l) => l.trim() === "## Follow-ups")) task += "\n## Follow-ups\n";
    task += `\n### ${now()}\n\n${text.trim()}\n`;
    writeAtomic(taskPath(project, id), task);
  });
}

/** The lines of a report's `## Next` section, list markers removed. */
export function nextLines(report) {
  const out = [];
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

export function allNext(project, id) {
  const extra = readText(extraNextPath(project, id)).split("\n").map((l) => l.trim().replace(/^- /, "")).filter(Boolean);
  return [...nextLines(readText(homeReportPath(project, id))), ...extra];
}

// ------------------------------------------------------------ briefs

function memoryFiles(project) {
  let names = [];
  try { names = readdirSync(project.path("memory")).filter((n) => n.endsWith(".md") && !n.startsWith(".")).sort(); } catch {}
  return names.map((n) => [n, host(null).read(project.path("memory", n))]).filter(([, text]) => text !== null);
}

export function composeBrief(i) {
  let b = "# Project\n\n";
  b += `- Project: ${i.projectName} (\`${i.slug}\`)\n`;
  b += `- Goal: ${i.goal.trim() || "(none set)"}\n`;
  if (!i.repos.length) b += "- Repos: (none)\n";
  else b += "- Repos:\n" + i.repos.map((r) => (r.machine ? `  - ${r.path} on machine \`${r.machine}\`\n` : `  - ${r.path} (local)\n`)).join("");
  b += `- Uploads, files from the user: \`${i.uploads}\`${i.remote ? " (on the home machine; not copied to yours)" : ""}\n`;
  b += `- Library, files for the user: \`${i.library}\`\n- Report: \`${i.report}\`\n\n`;
  b += i.threadMd.trimEnd() + "\n\n";
  if (i.restart) b += "**A previous attempt at this task exists on this branch.** Read its report at the report path below first, look at what is already on the branch, and continue from there.\n\n";
  b += `# Project instructions\n\n${i.instructions.trim()}\n\n# Project memory\n\n${i.memoryIndex.trim()}\n`;
  let used = [...i.memoryIndex].length;
  const left = [];
  for (const [name, text] of i.memoryFiles) {
    const size = [...text].length;
    if (used + size <= MEMORY_CAP_CHARS) { used += size; b += `\n## memory/${name}\n\n${text.trim()}\n`; }
    else left.push(`memory/${name}`);
  }
  if (left.length) b += `\nNot inlined because project memory is over ${MEMORY_CAP_CHARS} characters: ${left.join(", ")}.\n`;
  b += "\n# Progress\n\n";
  b += i.reportCommand
    ? `Report your progress with \`${i.reportCommand} --percent N --activity '...'\` (five-point steps, a two-to-four-word activity). Use \`--activity '${WAITING}'\` before you stop to ask the user something, and \`--percent 100\` only when the whole task is done. A failed report never stops the work.\n`
    : "Report progress with `pp report --percent N --activity '...'` if that command exists on this machine; otherwise skip it.\n";
  b += `\n# Task\n\n${i.task.trim()}\n\n# Paths\n\n- Report: \`${i.report}\`\n- Library folder for files meant for the user: \`${i.library}\`\n- Uploads from the user: \`${i.uploads}\`\n`;
  return b;
}

export function briefFor(project, t, restart) {
  const { settings, instructions } = project.read();
  const pfx = prefix(project.root);
  return composeBrief({
    projectName: project.displayName(settings), slug: project.slug, goal: settings.goal, repos: settings.repos,
    uploads: project.path("uploads"), remote: Boolean(t.machine), instructions,
    memoryIndex: readText(project.path("MEMORY.md")), memoryFiles: memoryFiles(project),
    task: readText(taskPath(project, t.id)), restart, threadMd: readFileSync(THREAD_MD, "utf8"),
    report: `${t.thread_dir}/report.md`, library: `${t.thread_dir}/library`,
    reportCommand: t.machine ? "" : `${pfx} report --thread ${project.slug}/${t.id}`,
  });
}

/** The thread directory, kept out of git, and brief.md, on the thread's machine. */
function writeBrief(project, t, restart) {
  const h = host(t.machine);
  h.write(`${t.thread_dir}/brief.md`, briefFor(project, t, restart));
  h.shell(`mkdir -p ${q(`${t.thread_dir}/library`)}`);
  // Adds `.paseo-project/` to info/exclude so nothing in it is ever committed.
  h.shell(`f=$(git rev-parse --git-path info/exclude 2>/dev/null) || exit 0; mkdir -p "$(dirname "$f")" && { grep -qxF '.paseo-project/' "$f" 2>/dev/null || echo '.paseo-project/' >> "$f"; }`, t.cwd);
}

// ------------------------------------------------------------ live state

/** The project's agents per daemon: Map(agentId → snapshot). Null for a daemon that did not answer. */
export async function agentsOf(project, machines = new Set([""])) {
  const out = new Map();
  const config = loadConfig();
  for (const m of machines) {
    try {
      const url = m ? machineOf(config, m).url : undefined;
      const c = await client(url);
      // shortcut: one page of 200 live agents per project; paginate if a project ever runs more.
      const r = await c.agents.list({ filter: { labels: { project: project.slug } }, page: { limit: 200 } });
      for (const e of r.entries) out.set(e.agent.id, e.agent);
    } catch (e) {
      out.unreachable = [...(out.unreachable ?? []), m || "local"];
      out.error = e.message;
    }
  }
  return out;
}

export function progressOf(project, id) {
  return readJson(progressPath(project, id), null);
}

/** What Paseo shows for a thread's agent right now. */
export function liveOf(t, agent, progress, at = Date.now()) {
  let state = null, exists = Boolean(agent && !agent.archivedAt && agent.status !== "closed");
  if (exists) {
    if (agent.pendingPermissions?.length) state = "blocked";
    else if (agent.status === "running" || agent.status === "initializing") state = "working";
    else if (agent.status === "error") state = "error";
    else state = "idle";
  }
  const stateSecs = state && state === t.last_state ? secondsSince(t.last_state_change, at) : 0;
  const age = progress ? Math.floor(at / 1000) - progress.reported_at : Infinity;
  return {
    exists, state, stateSecs, error: agent?.lastError ?? "", progress,
    selfWaiting: progress?.activity === WAITING && state !== "working",
    selfWorking: Boolean(progress) && progress.percent !== 100 && progress.activity !== WAITING && age < ACTIVITY_TTL_SECS,
  };
}

export const GROUPS = {
  "waiting-on-you": { label: "Waiting on you", rank: 1 },
  "ready-for-review": { label: "Ready for review", rank: 2 },
  landing: { label: "Landing", rank: 3 },
  working: { label: "Working", rank: 4 },
  idle: { label: "Idle", rank: 5 },
  resolved: { label: "Resolved", rank: 6 },
};

/** The group of a thread and why; first matching row wins. */
export function group(t, live, at = Date.now()) {
  const hasReport = Boolean(t.report_hash);
  if (t.status === "resolved") return { group: "resolved", note: t.resolved_reason || "resolved" };
  if (t.status === "starting") return secondsSince(t.created, at) < STARTING_TIMEOUT_SECS ? { group: "working", note: "starting" } : { group: "waiting-on-you", note: "start timed out" };
  if (t.status === "failed") return { group: "waiting-on-you", note: "start failed" };
  if (!live.exists && !hasReport) return { group: "waiting-on-you", note: "agent gone" };
  if (live.state === "error") return { group: "waiting-on-you", note: "agent error" };
  if (live.state === "blocked" && live.stateSecs >= BLOCKED_DEBOUNCE_SECS) return { group: "waiting-on-you", note: "blocked" };
  if (live.selfWaiting) return { group: "waiting-on-you", note: "waiting for you" };
  const prOpen = t.pr_state.toUpperCase() === "OPEN";
  if (prOpen && t.pr_review.toUpperCase() === "APPROVED") return { group: "landing", note: "PR approved" };
  const newReport = hasReport && t.report_hash !== t.acked_report_hash;
  if ((newReport || (hasReport && prOpen)) && live.state !== "working") return { group: "ready-for-review", note: newReport ? "new report" : "PR open" };
  if (live.state === "working" || live.state === "blocked" || live.selfWorking) return { group: "working", note: live.state ?? "reported progress" };
  return { group: "idle", note: live.exists ? "idle" : "agent gone" };
}

/** One line of state: `working · 55% Writing tests`. */
export function stateLine(live) {
  const p = live.progress;
  const pct = p && p.percent != null ? ` · ${p.percent}%` : "";
  return `${live.state ?? "no agent"}${pct}${p?.activity ? ` ${p.activity}` : ""}`;
}

/** Every thread with its live state and group, for list/show/context/overview. */
export async function rows(project) {
  const threads = list(project);
  const machines = new Set(threads.filter((t) => t.status !== "resolved").map((t) => t.machine || ""));
  machines.add("");
  const agents = await agentsOf(project, machines);
  return threads.map((t) => {
    const live = liveOf(t, agents.get(t.agent_id), progressOf(project, t.id));
    return { t, live, ...group(t, live), agent: agents.get(t.agent_id) ?? null };
  });
}

// ------------------------------------------------------------ copy home

/** Copies a thread's report home (and, with `withLibrary`, its library). */
export function copyHome(project, t, withLibrary = false) {
  if (!t.thread_dir) return { outcome: "complete", notes: [], hash: null };
  let h;
  try { h = host(t.machine); } catch (e) { return { outcome: "failed", error: e.message, notes: [] }; }
  if (!h.isDir(t.thread_dir)) return { outcome: "complete", notes: [], hash: null };
  const notes = [];
  const report = h.read(`${t.thread_dir}/report.md`);
  let hash = null;
  if (report !== null) {
    hash = sha256(report);
    if (hash !== t.report_hash || !existsSync(homeReportPath(project, t.id))) project.lock(() => writeAtomic(homeReportPath(project, t.id), report));
  }
  if (withLibrary && h.isDir(`${t.thread_dir}/library`)) {
    const lib = `${t.thread_dir}/library`;
    const du = h.shell(`du -sk ${q(lib)}`);
    const kb = Number(du.stdout.split(/\s+/)[0]);
    if (!du.ok || Number.isNaN(kb)) return { outcome: "failed", error: "could not measure the library folder", notes, hash };
    if (kb > LIBRARY_CAP_KB) notes.push(`the library is ${Math.floor(kb / 1024)} MB, over the ${LIBRARY_CAP_KB / 1024} MB cap; nothing from it was copied`);
    else if (kb > 4) { // an empty folder is 0–4 KB
      const target = project.path("library", t.id);
      mkdirSync(target, { recursive: true });
      // `-rt` without `-l`: symbolic links are skipped, never followed.
      const src = h.remote ? `${h.ssh}:${lib}/` : `${lib}/`;
      const r = sh(["rsync", "-rt", ...(h.remote ? ["-e", "ssh -o BatchMode=yes"] : []), src, `${target}/`], undefined, undefined, { timeout: 120_000 });
      if (!r.ok) return { outcome: "failed", error: `rsync failed: ${r.out}`, notes, hash };
      if (/skipping non-regular/.test(r.out)) notes.push("symbolic links in the library were not copied");
    }
  }
  return { outcome: notes.length ? "partial" : "complete", notes, hash };
}

// ------------------------------------------------------------ start

/**
 * A tab thread with a repo runs in a workspace of that repo's Paseo project, so the sidebar shows it
 * under the repo; its folder stays threads/<id>/. A restart reuses the workspace (creating twice makes two).
 * shortcut: a repo Paseo has no project for gets null (the thread's own workspace, as before); add the project then.
 */
export async function tabWorkspace(c, cwd, repo, title) {
  if (!repo) return null;
  const p = (await c.projects.list()).projects.find((x) => canonical(x.projectRootPath) === canonical(repo));
  if (!p) return null;
  const old = (await c.workspaces.list()).entries.find((w) => w.projectId === p.projectId && canonical(w.workspaceDirectory) === canonical(cwd));
  return old ? c.workspaces.ref(old.id) : c.workspaces.create({ source: { kind: "directory", path: cwd, projectId: p.projectId }, title });
}

/** `thread start`: places the agent, writes the brief, sends the one-line prompt. */
export async function start(project, a) {
  const status = project.status;
  if (status !== "active") throw new Error(`\`${project.slug}\` is ${status}; \`thread start\` is refused until it is active again`);
  if (!a.title?.trim()) throw new Error("--title may not be empty");
  if (!a.task?.trim()) throw new Error("the task is empty");
  const { settings } = project.read();
  const config = loadConfig();
  const safety = loadSafety(config, project.dir);
  const machine = a.machine ?? "";
  if (machine && !a.repo) throw new Error("a remote thread needs --repo: a task with no repository runs as a folder thread in the project, which is local");
  const kind = a.kind ?? (a.repo ? "worktree" : "tab");
  if (!["worktree", "tab", "checkout"].includes(kind)) throw new Error(`\`${kind}\` is not a thread kind (worktree, tab or checkout)`);
  if ((kind === "worktree" || kind === "checkout") && !a.repo) throw new Error("a worktree or checkout thread needs --repo");
  if (kind !== "worktree" && machine) throw new Error("a tab or checkout thread runs locally; a remote repo needs a worktree thread");
  const profile = resolveProfile(config, safety, settings, "thread", a.profile, project.slug);
  const h = host(machine, config);
  const warnings = [];
  if (a.repo && !settings.repos.some((r) => r.path.replace(/\/+$/, "") === a.repo.replace(/\/+$/, "") && (r.machine ?? "") === machine)) warnings.push(`${a.repo} is not one of the project's repos (\`set ${project.slug} repos.add\` lists it)`);
  const open = list(project).filter((t) => t.status !== "resolved").length;
  if (open >= settings.max_parallel_threads) warnings.push(`${open} threads are already open (max_parallel_threads is ${settings.max_parallel_threads})`);

  let repo = "", origin = "";
  if (a.repo) {
    repo = a.repo.replace(/\/+$/, "");
    const top = h.shell("git rev-parse --show-toplevel", repo);
    if (!top.ok) throw new Error(`${repo}${machine ? ` on ${machine}` : ""} is not a git repository: ${top.out}`);
    repo = top.stdout.trim();
    origin = h.shell("git remote get-url origin", repo).stdout.trim();
  }

  const t = allocate(project, (t) => Object.assign(t, { title: a.title.trim(), kind, repo, origin, machine, base: a.base ?? "", profile: profile.name, provider: profile.provider }));
  writeAtomic(taskPath(project, t.id), a.task.trimEnd() + "\n");
  if (kind === "worktree") t.branch = branchName(project.slug, t.id, t.title);

  try {
    const c = await client(h.url);
    const cwd = kind === "tab" ? project.path("threads", t.id) : repo;
    if (kind === "tab") mkdirSync(cwd, { recursive: true });
    const ws = kind === "tab" ? await tabWorkspace(c, cwd, repo, t.title) : null;
    const handle = await (ws ? ws.agents : c.agents).create({
      config: agentConfig(profile, safety),
      cwd,
      title: `${project.displayName(settings)} · ${t.id} ${t.title}`.slice(0, 120),
      labels: { project: project.slug, role: "thread", thread: t.id },
      env: machine ? undefined : { PP_THREAD: `${project.slug}/${t.id}` },
      ...(kind === "worktree" ? { worktree: { mode: "branch-off", newBranch: t.branch, ...(t.base ? { base: t.base } : {}) } } : {}),
    });
    await handle.refresh();
    const snap = handle.current();
    const placed = update(project, t.id, (r) => Object.assign(r, {
      agent_id: handle.id, workspace_id: snap?.workspaceId ?? "", cwd: snap?.cwd ?? cwd, branch: t.branch,
    }));
    placed.thread_dir = threadDir(placed.cwd, project.slug, t.id);
    update(project, t.id, (r) => { r.thread_dir = placed.thread_dir; });
    writeBrief(project, placed, false);
    refreshBranch(project, placed);
    await handle.send(launchPrompt(project.slug, t.id));
    return { thread: update(project, t.id, (r) => { r.status = "open"; r.error = ""; }), warnings };
  } catch (e) {
    update(project, t.id, (r) => { r.status = "failed"; r.error = e.message; });
    throw new Error(`${t.id} did not start: ${e.message}; \`thread restart ${project.slug} ${t.id}\` tries again`);
  }
}

// ------------------------------------------------------------ restart

/**
 * Claude keeps each session as `~/.claude/projects/<cwd, non-alphanumerics as ->/<id>.jsonl`; the newest one.
 * shortcut: newest by mtime, so a side session started later in the same folder wins; pass the id then.
 */
export function latestSession(cwd, base = join(homedir(), ".claude", "projects")) {
  const dir = claudeDir(cwd, base);
  let best = null;
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith(".jsonl")) continue;
      const m = statSync(join(dir, n)).mtimeMs;
      if (!best || m > best.m) best = { id: n.slice(0, -6), m };
    }
  } catch {}
  return best?.id ?? null;
}

/** The session a restart picks up: `--session`, else the old agent's or the record's; null starts fresh. */
export function sessionFor(t, agent, kind, { fresh = false, session } = {}) {
  if (fresh) return null;
  if (session) {
    if (session !== "latest") return { provider: kind, id: session };
    if (kind !== "claude") throw new Error("`--session latest` finds Claude sessions only; give the session id");
    const id = latestSession(t.cwd);
    if (!id) throw new Error(`no Claude session for ${t.cwd}`);
    return { provider: kind, id };
  }
  const p = agent?.persistence;
  const s = p?.sessionId ? { provider: p.provider, id: p.sessionId } : t.session;
  return s?.id && s.provider === kind ? s : null;
}

/** A thread whose folder moved (from herdr, or a new worktree) keeps its last report: the old folder's, else the home copy. */
export function carryReport(h, from, to, home) {
  if (from === to || h.read(`${to}/report.md`) !== null) return;
  const old = (from && h.read(`${from}/report.md`)) || home;
  if (old) h.write(`${to}/report.md`, old);
}

/** `thread restart`: an agent on the same worktree, folder or branch; it picks up the old session unless `fresh`. */
export async function restart(project, id, requested, opts = {}) {
  const t = load(project, id);
  if (t.status === "resolved") throw new Error(`${id} is resolved; \`thread resolve --reopen\` first`);
  if (t.status === "starting" && secondsSince(t.created) < STARTING_TIMEOUT_SECS) throw new Error(`${id} is still starting`);
  const agents = await agentsOf(project, new Set([t.machine]));
  const live = liveOf(t, agents.get(t.agent_id), null);
  if (live.exists && live.state !== "error") throw new Error(`${id} is running: it has an agent (${live.state}); \`thread prompt\` reaches it`);
  const { settings } = project.read();
  const config = loadConfig();
  const safety = loadSafety(config, project.dir);
  const profile = resolveProfile(config, safety, settings, "thread", requested || t.profile, project.slug);
  const h = host(t.machine, config);
  const c = await client(h.url);
  if (t.agent_id && agents.has(t.agent_id)) await c.agents.ref(t.agent_id).archive().catch(() => {});

  let cwd = t.cwd, worktree;
  if (t.kind === "tab") { cwd = project.path("threads", id); mkdirSync(cwd, { recursive: true }); }
  else if (!cwd || !h.isDir(cwd)) {
    if (t.kind !== "worktree") throw new Error(`${t.repo} is gone`);
    if (!t.branch || !h.shell(`git show-ref --verify --quiet ${q(`refs/heads/${t.branch}`)}`, t.repo).ok) throw new Error(`${id}'s worktree and branch are both gone; start a new thread`);
    cwd = t.repo;
    worktree = { mode: "checkout-branch", branch: t.branch };
  }
  // A session belongs to its folder: a new worktree cannot pick it up.
  if (worktree && opts.session) throw new Error(`${id}'s worktree is gone, so its session cannot be picked up; restart without --session`);
  const session = worktree ? null : sessionFor(t, agents.get(t.agent_id), kindOf(profile), opts);
  const cfg = agentConfig(profile, safety);
  const title = `${project.displayName(settings)} · ${id} ${t.title}`.slice(0, 120);
  const labels = { project: project.slug, role: "thread", thread: id };
  const ws = t.kind === "tab" ? await tabWorkspace(c, cwd, t.repo, t.title) : null;
  let handle;
  if (session) {
    // shortcut: an imported agent has no PP_THREAD; the brief's `report` command names the thread anyway.
    try {
      const a = await importSession(h.url, { provider: session.provider, sessionId: session.id, cwd, workspaceId: ws?.id, labels, model: modelOf(profile), modeId: cfg.modeId, title });
      handle = c.agents.ref(a.id);
    } catch (e) { throw new Error(`${id}: session ${session.id} could not be picked up (${e.message}); \`thread restart ${project.slug} ${id} --fresh\` starts a new one`); }
  } else {
    handle = await (ws ? ws.agents : c.agents).create({
      config: cfg, cwd, title, labels,
      env: t.machine ? undefined : { PP_THREAD: `${project.slug}/${id}` },
      ...(worktree ? { worktree } : {}),
    });
  }
  await handle.refresh();
  const snap = handle.current();
  const placed = update(project, id, (r) => Object.assign(r, {
    agent_id: handle.id, workspace_id: snap?.workspaceId ?? r.workspace_id, cwd: snap?.cwd ?? cwd,
    profile: profile.name, provider: profile.provider, status: "open", error: "", session,
  }));
  placed.thread_dir = threadDir(placed.cwd, project.slug, id);
  update(project, id, (r) => { r.thread_dir = placed.thread_dir; });
  carryReport(h, t.thread_dir, placed.thread_dir, readText(homeReportPath(project, id)));
  writeBrief(project, placed, true);
  await handle.send(launchPrompt(project.slug, id));
  return placed;
}

// ------------------------------------------------------------ talking to a thread

async function handleOf(project, t) {
  if (!t.agent_id) throw new Error(`${t.id} has no agent; \`thread restart\` gives it one`);
  const c = await client(host(t.machine).url);
  const handle = c.agents.ref(t.agent_id);
  await handle.refresh();
  const snap = handle.current();
  if (!snap || snap.archivedAt || snap.status === "closed") throw new Error(`${t.id}'s agent is gone; \`thread restart ${project.slug} ${t.id}\` brings it back`);
  return { handle, snap };
}

/** Sends a follow-up, recorded in the task file. A busy agent gets it mid-turn (steer). */
export async function prompt(project, id, text) {
  if (!text.trim()) throw new Error("the text is empty");
  const t = load(project, id);
  if (t.status === "resolved") throw new Error(`${id} is resolved`);
  const { handle, snap } = await handleOf(project, t);
  if (snap.pendingPermissions?.length) throw new Error(`${id} is blocked on a permission request: \`thread permissions ${project.slug} ${id}\` shows it; answer it first`);
  appendFollowUp(project, id, text);
  const state = snap.status === "running" ? "working" : snap.status;
  await handle.send(text, { activeTurnBehavior: "steer" });
  return state;
}

/** `thread next`: forward line N of the Next list, or add a line. */
export async function next(project, id, line, add) {
  load(project, id);
  if (add !== undefined) {
    if (!add.trim() || add.includes("\n")) throw new Error("a Next line is one non-empty line");
    project.lock(() => writeAtomic(extraNextPath(project, id), readText(extraNextPath(project, id)) + `- ${add.trim()}\n`));
    return `added to ${id}'s Next list`;
  }
  const lines = allNext(project, id);
  if (!line || line < 1 || line > lines.length) throw new Error(`${id}'s Next list has ${lines.length} line(s); give --line 1..${lines.length}`);
  const state = await prompt(project, id, lines[line - 1]);
  return `sent line ${line} to ${id} (agent was ${state})`;
}

/** `thread stop`: interrupts the agent's turn (Paseo's own stop). */
export async function stop(project, id) {
  const t = load(project, id);
  if (!t.agent_id) throw new Error(`${id} has no agent`);
  const url = host(t.machine).url;
  const r = sh(["paseo", "stop", t.agent_id, ...(url ? ["--host", url] : [])]);
  if (!r.ok) throw new Error(`paseo stop: ${r.out}`);
}

/** Pending permission requests, framed as data. */
export async function permissions(project, id) {
  const { snap } = await handleOf(project, load(project, id));
  return snap.pendingPermissions ?? [];
}

export function describePermission(p) {
  const input = p.input ? JSON.stringify(p.input, null, 2) : "";
  const lines = [`- request ${p.id} [${p.kind}] ${p.name}${p.title ? `: ${p.title}` : ""}`];
  if (p.description) lines.push(`  description: ${p.description}`);
  if (input) lines.push(`  input: ${input.length > 2000 ? input.slice(0, 2000) + "…" : input}`.replace(/\n/g, "\n  "));
  if (p.actions?.length) lines.push(`  actions: ${p.actions.map((a) => `${a.id} (${a.behavior}: ${a.label})`).join(", ")}`);
  return lines.join("\n");
}

/** Answers one permission request: allow once (never "always"), or deny. */
export async function answer(project, id, { behavior, request, action, message, answers }) {
  const t = load(project, id);
  const { handle, snap } = await handleOf(project, t);
  const pending = snap.pendingPermissions ?? [];
  if (!pending.length) throw new Error(`${id} has no pending permission request`);
  const p = request ? pending.find((x) => x.id === request) : pending.length === 1 ? pending[0] : null;
  if (!p) throw new Error(request ? `${id} has no request \`${request}\`` : `${id} has ${pending.length} requests; pick one with --request`);
  const response = behavior === "allow"
    ? { behavior: "allow", ...(action ? { selectedActionId: action } : {}), ...(answers ? { updatedInput: { ...(p.input ?? {}), answers } } : {}) }
    : { behavior: "deny", ...(action ? { selectedActionId: action } : {}), ...(message ? { message } : {}) };
  await handle.respondToPermission({ requestId: p.id, response });
  return p;
}

export function ack(project, id) {
  const t = load(project, id);
  update(project, id, (r) => { r.acked_report_hash = t.report_hash; });
}

/** `report`: a thread's own progress, read by the ticker. */
export function reportProgress(project, id, percent, activity) {
  load(project, id);
  const clean = [...String(activity ?? "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").trim()].slice(0, 40).join("");
  writeJson(progressPath(project, id), { percent: percent ?? null, activity: percent === 100 ? "Done" : clean, reported_at: Math.floor(Date.now() / 1000) });
}

// ------------------------------------------------------------ resolve and clean

/** The worktree's current branch, read again: Paseo or the agent may rename it. */
export function refreshBranch(project, t) {
  if (t.kind !== "worktree" || !t.cwd) return t;
  try {
    const r = host(t.machine).shell("git branch --show-current", t.cwd, undefined, 5000);
    const b = r.ok ? r.stdout.trim() : "";
    if (b && b !== t.branch) return update(project, t.id, (x) => { x.branch = b; });
  } catch {}
  return t;
}

/** Archives the agent, removes the worktree (never forced), deletes a merged branch. */
export async function clean(project, t, { keepWorktree = false, copyComplete = true, mergedHead = "" } = {}) {
  const notes = [];
  let h;
  try { h = host(t.machine); } catch (e) { return [e.message]; }
  if (t.agent_id) {
    try { const c = await client(h.url); await c.agents.ref(t.agent_id).archive(); notes.push("agent archived"); }
    catch (e) { notes.push(`agent not archived: ${e.message}`); }
  }
  // A tab thread's workspace goes with it (its folder stays); a worktree's goes with the worktree below.
  if (t.kind === "tab" && t.workspace_id) { try { const c = await client(h.url); await c.workspaces.archive(t.workspace_id); } catch {} }
  if (t.kind !== "worktree" || !t.cwd) return notes;
  if (keepWorktree) { notes.push(`worktree kept at ${t.cwd}`); return notes; }
  if (!copyComplete) { notes.push(`worktree kept at ${t.cwd}: the final copy was partial (\`thread resolve --force\` removes it)`); return notes; }
  if (h.isDir(t.cwd)) {
    const r = h.shell(`git worktree remove -- ${q(t.cwd)}`, t.repo);
    if (!r.ok) { notes.push(`worktree kept: ${r.out}`); return notes; }
    notes.push("worktree removed");
  } else {
    h.shell("git worktree prune", t.repo);
    notes.push("worktree folder was already gone; pruned");
  }
  if (t.workspace_id) { try { const c = await client(h.url); await c.workspaces.archive(t.workspace_id); } catch {} }
  if (mergedHead && t.branch) {
    const tip = h.shell(`git rev-parse --verify -q ${q(`refs/heads/${t.branch}`)}`, t.repo);
    if (!tip.ok) notes.push("no local branch left");
    else if (tip.stdout.trim() !== mergedHead) notes.push(`branch ${t.branch} kept: it has commits that are not in the merged pull request`);
    else { const d = h.shell(`git branch -D -- ${q(t.branch)}`, t.repo); notes.push(d.ok ? `branch ${t.branch} deleted` : `branch kept: ${d.out}`); }
  }
  return notes;
}

/** Final copy, then resolved, then cleanup, then one inbox item. */
export async function resolve(project, id, { keepWorktree = false, force = false, skipCopy = false, reason = "user", mergedHead = "", why } = {}) {
  const t = refreshBranch(project, load(project, id));
  if (t.status === "resolved") throw new Error(`${id} is already resolved; \`sweep ${project.slug}\` cleans what is left of it`);
  let copied = { outcome: "complete", notes: [] };
  if (!skipCopy) {
    copied = copyHome(project, t, true);
    if (copied.outcome === "failed") throw new Error(`the final copy failed (${copied.error}); not resolving. \`--skip-copy\` resolves without it.`);
  }
  const resolved = update(project, id, (r) => {
    r.status = "resolved"; r.resolved_reason = reason; r.kept_worktree = keepWorktree;
    if (copied.hash) r.report_hash = copied.hash;
  });
  const notes = [...copied.notes, ...(await clean(project, resolved, { keepWorktree, copyComplete: copied.outcome === "complete" || force, mergedHead }))];
  inbox.write(project, "thread-state", id, "resolved", `${id} "${t.title}" ${why ?? "was resolved"}: ${notes.join("; ")}`);
  return notes;
}

export function reopen(project, id) {
  const t = load(project, id);
  if (t.status !== "resolved") throw new Error(`${id} is not resolved`);
  return update(project, id, (r) => { r.status = "open"; r.resolved_reason = ""; });
}

// ------------------------------------------------------------ printing

export function rowJson(project, row) {
  return { ...row.t, group: row.group, group_label: GROUPS[row.group].label, note: row.note, state: row.live.state, progress: row.live.progress, next: allNext(project, row.t.id), report: homeReportPath(project, row.t.id) };
}

export function rowLine(row) {
  const t = row.t;
  return `${t.id} [${GROUPS[row.group].label}] (${row.note}) ${t.title} — ${t.repo ? `${t.repo}${t.machine ? ` on ${t.machine}` : ""}` : "no repo"} — ${t.profile || t.provider}`;
}

export const isOpen = (t) => t.status !== "resolved";
export const sortRows = (rs) => rs.sort((a, b) => GROUPS[a.group].rank - GROUPS[b.group].rank || a.t.id.localeCompare(b.t.id));
