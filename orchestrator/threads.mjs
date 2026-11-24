// Threads: one Paseo agent each, on its own worktree (or a folder, or the
// repo's checkout). Records in threads/<id>.json; the agent works from
// <cwd>/.paseo-project/<slug>-<id>/ (brief.md, report.md, library/).
import { mkdirSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { REPO, client, autoArchiveAfterMerge, importSession, sh, now, readText, readJson, writeJson, writeAtomic, sha256, secondsSince, slugify, claudeDir, isDir, requirePerson } from "./lib.mjs";
import { loadConfig, loadSafety, resolveProfile, agentConfig, kindOf, modelOf, canonical, machine as machineOf } from "./config.mjs";
import { prefix } from "./project.mjs";
import * as inbox from "./inbox.mjs";
import * as cleanup from "./cleanup.mjs";
import { deleteOvnfsCheckout, dispose } from "./disposal.mjs";
import { LifecycleBusy, withLifecycleLock } from "./lifecycle-lock.mjs";
import * as ovnfs from "./ovnfs.mjs";
import * as managedOvnfs from "./managed-ovnfs.mjs";
import * as workingCopy from "./working-copy.mjs";
import { branchIdentityBlocker, discover, isLegacy, verifyLegacyGit } from "./reconciliation.mjs";
import { capturePlan, checkCapacity, createCapture, importSeed, materializeCache, planCache, verifySeed } from "./copy-inputs.mjs";
import { validPrUrl } from "./pr.mjs";


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
    writeJson(recordPath(project, id), t, Boolean(t.working_copy || t.working_copies?.length));
    return t;
  });
}

function allocate(project, task, fill) {
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
    writeAtomic(taskPath(project, t.id), task.trimEnd() + "\n");
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
  if (t.working_copy?.blocker) return { group: "waiting-on-you", note: "worktree unconfirmed" };
  if (t.status === "starting") return secondsSince(t.launch_started ?? t.created, at) < STARTING_TIMEOUT_SECS ? { group: "working", note: "starting" } : { group: "waiting-on-you", note: "start timed out" };
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

/** Copies a thread's report home (and, with `withLibrary`, its library less the `exclude` paths, relative to it). */
export function copyHome(project, t, withLibrary = false, exclude = []) {
  if (!t.thread_dir) return { outcome: "complete", notes: [], hash: null };
  let h;
  try {
    h = host(t.machine);
    if (t.working_copy) verifyWorkingCopy(h, t);
  } catch (e) { return { outcome: "failed", error: e.message, notes: [] }; }
  if (!h.isDir(t.thread_dir)) {
    // Gone before a final copy. Only a complete one recorded for this agent proves the library home whole: a library
    // folder home may be a copy that failed part way, a record without `archive` (older pp) a `--force` that skipped
    // it, and one of an earlier agent the round before `restart` (which always gives a new agent, maybe on the same path).
    const rec = withLibrary ? readJson(project.path("threads", `${t.id}.cleanup.json`)) : null;
    if (!withLibrary || (rec?.archive === "complete" && rec.archive_agent === (t.agent_id ?? ""))) return { outcome: "complete", notes: [], hash: null };
    // The report comes home as it changes, the library only with a final copy: what is not home now is lost.
    const reportHome = existsSync(homeReportPath(project, t.id));
    const libraryHome = isDir(project.path("library", t.id));
    const missing = [...(reportHome ? [] : ["report"]), ...(libraryHome ? [] : ["library"])];
    const said = [...(missing.length ? [`${missing.join(" and ")} not copied home`] : []), ...(libraryHome ? ["whether the library home is complete is unknown"] : [])];
    return { outcome: missing.length ? "missing" : "unknown", missing, unknown: libraryHome ? ["library"] : [], hash: null, notes: [`the thread folder was already gone: ${said.join("; ")}${reportHome ? "; the report home is pp's last copy" : ""}`] };
  }
  const notes = [];
  const report = h.read(`${t.thread_dir}/report.md`);
  let hash = null;
  if (report !== null) {
    hash = sha256(report);
    if ((withLibrary && t.kind === "ovnfs") || hash !== t.report_hash || !existsSync(homeReportPath(project, t.id))) {
      project.lock(() => writeAtomic(homeReportPath(project, t.id), report));
    }
  }
  if (withLibrary && h.isDir(`${t.thread_dir}/library`)) {
    const lib = `${t.thread_dir}/library`;
    const du = h.shell(`du -sk ${q(lib)}`);
    const left = exclude.reduce((s, x) => s + (Number(h.shell(`du -sk ${q(`${lib}/${x}`)}`).stdout.split(/\s+/)[0]) || 0), 0);
    const kb = Number(du.stdout.split(/\s+/)[0]) - left;
    if (!du.ok || Number.isNaN(kb)) return { outcome: "failed", error: "could not measure the library folder", notes, hash };
    if (kb > LIBRARY_CAP_KB) notes.push(`the library is ${Math.floor(kb / 1024)} MB, over the ${LIBRARY_CAP_KB / 1024} MB cap; nothing from it was copied`);
    // Any file at all: one small file measures 4 KB, like an empty folder, and would be lost with the worktree.
    else if (h.shell(`find ${q(lib)} -type f -print -quit`).stdout.trim()) {
      const target = project.path("library", t.id);
      mkdirSync(target, { recursive: true });
      // `-rt` without `-l`: symbolic links are skipped, never followed.
      const src = h.remote ? `${h.ssh}:${lib}/` : `${lib}/`;
      const r = sh(["rsync", t.kind === "ovnfs" ? "-rtc" : "-rt", ...exclude.map((x) => `--exclude=/${x.replace(/[*?[\\]/g, "\\$&")}`), ...(h.remote ? ["-e", "ssh -o BatchMode=yes"] : []), src, `${target}/`], undefined, undefined, { timeout: 120_000 });
      if (!r.ok) return { outcome: "failed", error: `rsync failed: ${r.out}`, notes, hash };
      if (/skipping non-regular/.test(r.out)) notes.push("symbolic links in the library were not copied");
    }
  }
  return { outcome: notes.length ? "partial" : "complete", notes, hash };
}

// ------------------------------------------------------------ start

export const hasBranchCheckout = (t) => t.kind === "worktree" || t.kind === "ovnfs";

const copyBackend = (w) => w.backend === "ovnfs" ? managedOvnfs : workingCopy;

function admitWorkingCopy(project, h, args) {
  checkCapacity(project, () => {
    try {
      return readdirSync(project.path("threads")).filter((n) => /^t-\d{4,}\.json$/.test(n)).flatMap((name) => {
        const t = JSON.parse(readFileSync(project.path("threads", name), "utf8"));
        if (t?.id !== name.slice(0, -5) || (t.working_copies != null && !Array.isArray(t.working_copies))) throw new Error();
        const rows = resourcesOf(t);
        if (rows.some((w) => !w || typeof w !== "object" || w.owner !== t.id || !w.phase)) throw new Error();
        return rows;
      });
    } catch { throw new Error("working-copy resource budget could not be verified against the project registry"); }
  }, h, args);
}

function workingCopyRecord(t) {
  const w = t.working_copy;
  if (w.backend !== (t.kind === "ovnfs" ? "ovnfs" : "git-worktree") || w.owner !== t.id || w.source !== t.repo || w.machine !== t.machine || (t.cwd && w.path !== t.cwd)) {
    throw new Error(`${t.id}'s working-copy record does not match its checkout`);
  }
  return w;
}

function verifyWorkingCopy(h, t) {
  const w = workingCopyRecord(t);
  if (w.backend === "ovnfs" && ["removing", "unknown"].includes(w.disposal?.phase)) throw new Error("OVNFS checkout removal is unconfirmed");
  const path = copyBackend(w).verify(h, w);
  if (path !== t.cwd) throw new Error(`${t.id}'s working-copy record does not match its checkout`);
  return path;
}

function stageCache(project, h, w, identity, save) {
  if (w.cache?.state === "staging") throw new Error("cache staging is incomplete; retain the original checkout and verify its cache before use");
  const plan = planCache(project, h, w, identity);
  if (plan.items) {
    save({ ...plan.result, state: "staging" });
    materializeCache(plan);
  }
  return plan.result;
}

function reconcileWorkingCopy(project, t, h) {
  if (workingCopyRecord(t).phase === "creating") {
    let identity;
    try {
      const w = t.working_copy;
      identity = w.backend === "ovnfs" ? managedOvnfs.recover(h, w, () => snapshotCheckout(project, w)) : workingCopy.recover(h, w);
    } catch (e) {
      // Another pass may have recorded the identity and released the creation lock.
      t = load(project, t.id);
      if (workingCopyRecord(t).phase !== "ready") throw e;
    }
    if (identity) {
      const w = workingCopyRecord(t);
      if (w.seed) verifySeed(w, w.path);
      const cache = stageCache(project, h, w, identity, (intent) => {
        update(project, t.id, (r) => { workingCopyRecord(r).cache = intent; });
      });
      t = update(project, t.id, (r) => {
        const w = workingCopyRecord(r);
        if (w.phase !== "creating") return;
        Object.assign(w, { phase: "ready", identity, blocker: "", ...(cache ? { cache } : {}) });
        r.cwd = w.path;
        r.thread_dir = threadDir(w.path, project.slug, r.id);
        r.branch_start = { name: w.branch, oid: identity.initial_oid ?? w.seed?.oid ?? w.baseline };
      });
    }
  }
  verifyWorkingCopy(h, t);
  copyBackend(t.working_copy).unlockCreation?.(h, t.working_copy);
  return t;
}

function setWorkingCopyBlocker(project, t, blocker) {
  return blocker === t.working_copy.blocker ? t : update(project, t.id, (r) => {
    if (r.working_copy.phase === t.working_copy.phase) r.working_copy.blocker = blocker;
  });
}

function ovnfsResources(t) { return [t.working_copy, ...(t.working_copies ?? [])].filter(Boolean); }

export function ovnfsResource(project, id, type, name, { base, resource = "main" } = {}) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name ?? "") || name === "main") throw new Error("give --name (lowercase letters, digits, hyphens; 'main' is reserved)");
  return withLifecycleLock(project, () => {
    const t = load(project, id), h = host(t.machine);
    if (project.status !== "active" || t.status === "resolved") throw new Error("OVNFS resources require an active project and unresolved thread");
    if (t.kind !== "ovnfs" || t.working_copy?.backend !== "ovnfs") throw new Error("OVNFS resources require a managed OVNFS thread; existing legacy checkouts are not adopted");
    const all = ovnfsResources(t), main = workingCopyRecord(t);
    const source = resource === "main" ? main : all.find((w) => w.resource === resource);
    const snapshot = type === "snapshot";
    if (snapshot && (!source || source.owner !== id || source.backend !== "ovnfs" || source.ovnfs.label)) throw new Error(`no owned OVNFS checkout named ${resource}`);
    let w = all.find((r) => r.resource === name);
    if (w && (w.owner !== id || w.backend !== "ovnfs" || Boolean(w.ovnfs.label) !== snapshot ||
        (snapshot && w.depends_on[0] !== source.nonce) || (base !== undefined && w.ovnfs.ref !== base))) throw new Error(`OVNFS resource ${name} already has a different immutable intent`);
    if (!w) {
      managedOvnfs.verify(h, snapshot ? source : main);
      admitWorkingCopy(project, h, { additions: snapshot ? 1 : 2, namespace: main.ovnfs.namespace, inputs: !snapshot });
      if (snapshot) w = managedOvnfs.snapshotPlan(source, name);
      else {
        const branch = `${main.branch}-${name}`;
        w = managedOvnfs.plan({ ...t, branch }, workingCopy.gitBaseline(h, t.repo, base ?? (t.base || "HEAD")), main.ovnfs.namespace);
        w.resource = name;
        w.ovnfs.ref = base;
        w.ovnfs.capture = capturePlan(project, w);
      }
      update(project, id, (r) => { (r.working_copies ??= []).push(w); });
    }
    const current = reconcileOvnfsResource(project, t, h, w, { start: true });
    if (current.blocker) throw new Error(current.blocker);
    return current;
  });
}

function reconcileOvnfsResource(project, t, h, w, { start = false } = {}) {
  const snapshot = Boolean(w.ovnfs.label);
  const save = (change) => {
    update(project, t.id, (r) => {
      const item = r.working_copies?.find((entry) => entry.nonce === w.nonce);
      if (!item || item.owner !== t.id || item.phase !== w.phase) throw new Error("OVNFS resource intent changed while reconciling");
      Object.assign(item, change);
      w = item;
    });
  };
  const verifySource = () => {
    const matches = ovnfsResources(load(project, t.id)).filter((r) => r.nonce === w.depends_on[0]);
    if (matches.length !== 1 || matches[0].owner !== t.id || matches[0].identity?.name !== w.ovnfs.from.checkout || matches[0].identity?.base !== w.ovnfs.from.base) throw new Error("OVNFS snapshot source identity changed");
    managedOvnfs.verify(h, matches[0]);
  };
  let failed;
  try {
    if (w.phase === "planned" && start) {
      admitWorkingCopy(project, h, { namespace: w.ovnfs.namespace, inputs: !snapshot });
      if (snapshot) verifySource();
      else if (!w.ovnfs.capture?.oid) {
        const capture = createCapture(project, w, w.ovnfs.capture);
        save({ ovnfs: { ...w.ovnfs, capture } });
      }
      const parents = managedOvnfs.ensureAvailable(h, w);
      save({ phase: "creating", ovnfs: { ...w.ovnfs, started_at: now(), ...(snapshot ? { parents } : {}) } });
      try { managedOvnfs.create(h, w); } catch (e) { failed = e.message; }
    }
    if (w.phase === "creating") {
      if (snapshot) verifySource();
      const identity = managedOvnfs.recover(h, w);
      if (snapshot && !identity.tree) save({ identity, blocker: "OVNFS snapshot is registered; tree hashing is not yet confirmed" });
      else {
        managedOvnfs.verify(h, { ...w, phase: "ready", identity });
        const cache = stageCache(project, h, w, identity, (intent) => save({ cache: intent }));
        save({ identity, phase: "ready", blocker: "", ...(cache ? { cache } : {}) });
      }
    } else if (w.phase === "ready" && start) {
      managedOvnfs.verify(h, w);
      if (w.blocker) save({ blocker: "" });
    }
  } catch (e) {
    const blocker = failed ? `${e.message}; ${failed}` : e.message;
    if (blocker !== w.blocker) save({ blocker });
  }
  return w;
}

function prepareWorkingCopy(project, t, h) {
  if (t.working_copy.backend === "ovnfs") return withLifecycleLock(project, () => prepareCheckout(project, load(project, t.id), h));
  return prepareCheckout(project, t, h);
}

function snapshotSource(project, h, ref) {
  const match = /^(t-[0-9]+)\/([a-z][a-z0-9-]{0,47})$/.exec(ref ?? "");
  if (!match) throw new Error("--from-snapshot requires THREAD/RESOURCE in the same Project");
  const owner = load(project, match[1]);
  const rows = ovnfsResources(owner).filter((w) => w.resource === match[2]);
  const w = rows[0];
  if (rows.length !== 1 || w.owner !== owner.id || w.backend !== "ovnfs" || !w.ovnfs.label) throw new Error(`no managed OVNFS snapshot ${ref}`);
  managedOvnfs.verify(h, w);
  return w;
}

function snapshotCheckout(project, w) {
  const { owner, resource, snapshot, base } = w.ovnfs.from;
  const rows = ovnfsResources(load(project, owner)).filter((r) => r.owner === owner && r.backend === "ovnfs" && r.phase === "ready");
  const snapshots = rows.filter((r) => r.resource === resource && r.nonce === w.depends_on[0] && r.ovnfs.label === snapshot.label &&
    r.ovnfs.from?.checkout === snapshot.checkout && r.ovnfs.from?.base === base && r.identity?.id === snapshot.id && r.identity.tree === snapshot.tree);
  if (snapshots.length !== 1) return null;
  const sources = rows.filter((r) => r.nonce === snapshots[0].depends_on[0] && !r.ovnfs.label && r.source === w.source &&
    r.identity?.name === snapshot.checkout && snapshot.checkout === `pp-${r.nonce}` && r.identity.base === base);
  return sources.length === 1 ? sources[0] : null;
}

function prepareInputs(project, t, { recoverSeed = false } = {}) {
  const w = workingCopyRecord(t);
  if ((w.seed && !w.seed.oid) || (w.backend === "ovnfs" && !w.ovnfs.from && !w.ovnfs.capture?.oid)) {
    const capture = createCapture(project, w, w.seed ?? w.ovnfs.capture, Boolean(w.seed), { recoverOnly: Boolean(w.seed && recoverSeed) });
    return update(project, t.id, (r) => {
      if (w.seed) r.working_copy.seed = capture;
      if (w.backend === "ovnfs") r.working_copy.ovnfs.capture = capture;
    });
  }
  return t;
}

function prepareCheckout(project, t, h) {
  let createError;
  try {
    if (workingCopyRecord(t).phase === "planned") {
      const from = t.working_copy.ovnfs?.from;
      if (from) {
        const s = snapshotSource(project, h, `${from.owner}/${from.resource}`);
        if (s.nonce !== t.working_copy.depends_on[0] || s.ovnfs.from.base !== from.base || s.source !== t.repo) throw new Error("OVNFS snapshot dependency changed");
      }
      const w = t.working_copy;
      admitWorkingCopy(project, h, { repo: w.backend === "git-worktree" ? w.source : undefined, namespace: w.ovnfs?.namespace, inputs: Boolean(w.seed || w.ovnfs?.capture) });
      t = prepareInputs(project, t, { recoverSeed: true });
      if (t.working_copy.seed) {
        if (w.backend === "git-worktree") importSeed(t.working_copy);
        else verifySeed(t.working_copy);
      }
      copyBackend(t.working_copy).ensureAvailable?.(h, t.working_copy);
      t = update(project, t.id, (r) => {
        const w = workingCopyRecord(r);
        if (w.phase !== "planned") throw new Error(`${r.id}'s worktree creation already started`);
        w.phase = "creating";
        if (w.backend === "ovnfs") w.ovnfs.started_at = now();
      });
      try {
        const created = copyBackend(t.working_copy).create(h, t.working_copy);
        if (created && !created.ok && t.working_copy.backend === "git-worktree") createError = `git worktree add: ${created.out}`;
      } catch (e) { createError = e.message; }
    }
    t = reconcileWorkingCopy(project, t, h);
    return setWorkingCopyBlocker(project, t, "").cwd;
  } catch (e) {
    const message = createError ? `${e.message}; ${createError}` : e.message;
    setWorkingCopyBlocker(project, load(project, t.id), message);
    throw new Error(message);
  }
}

/** Ticker checks the resource, but never starts a new worktree or agent. */
export function checkWorktree(project, t, at) {
  if (!t.working_copy) return t;
  try { return withLifecycleLock(project, () => checkWorktreeLocked(project, load(project, t.id), at)); }
  catch (e) { if (e instanceof LifecycleBusy) return load(project, t.id); throw e; }
}

function checkWorktreeLocked(project, t, at) {
  if (!t.working_copy || t.status === "resolved" || ["planned", "removed"].includes(t.working_copy.phase)) return t;
  if (t.status === "starting" && secondsSince(t.launch_started ?? t.created, at) < STARTING_TIMEOUT_SECS) return t;
  const check = () => {
    if (t.working_copy.backend === "ovnfs") {
      t = load(project, t.id);
      for (const w of t.working_copies ?? []) {
        if (w.owner === t.id && w.backend === "ovnfs" && w.phase === "creating") reconcileOvnfsResource(project, t, host(t.machine), w);
      }
      t = load(project, t.id);
    }
    try {
      t = reconcileWorkingCopy(project, t, host(t.machine));
      return setWorkingCopyBlocker(project, t, "");
    } catch (e) {
      return setWorkingCopyBlocker(project, load(project, t.id), e.message);
    }
  };
  return t.working_copy.backend === "ovnfs" ? withLifecycleLock(project, check) : check();
}

function requireLocalPaseo() {
  const { hostname } = new URL(process.env.PASEO_URL || "ws://127.0.0.1:6767/ws");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) throw new Error("an OVNFS thread needs a local Paseo daemon");
}

function ovnfsCwd(project, t) {
  if (!t.cwd) {
    const placement = ovnfs.prepare(t);
    t = update(project, t.id, (r) => Object.assign(r, placement));
  } else if (!ovnfs.mounted(t)) {
    throw new Error(`${t.id}'s OVNFS checkout is gone; start a new thread`);
  }
  if (!t.ovnfs_ready) {
    const oid = ovnfs.createBranch(t.cwd, t.branch);
    update(project, t.id, (r) => {
      r.ovnfs_ready = true;
      r.branch_start = { name: t.branch, oid };
    });
  }
  return t.cwd;
}

/**
 * A tab thread with a repo runs in a workspace of that repo's Paseo project, so the sidebar shows it
 * under the repo; its folder stays threads/<id>/. A restart reuses the workspace (creating twice makes two).
 * shortcut: a repo Paseo has no project for gets null (the thread's own workspace, as before); add the project then.
 */
export async function tabWorkspace(c, cwd, repo, title, remote = false) {
  if (!repo) return null;
  const pathOf = remote ? (path) => path.replace(/\/+$/, "") : canonical;
  const p = (await c.projects.list()).projects.find((x) => pathOf(x.projectRootPath) === pathOf(repo));
  if (!p) return null;
  const old = (await c.workspaces.list()).entries.find((w) => w.projectId === p.projectId && pathOf(w.workspaceDirectory) === pathOf(cwd));
  return old ? c.workspaces.ref(old.id) : c.workspaces.create({ source: { kind: "directory", path: cwd, projectId: p.projectId }, title });
}

const neverDispatchedAgent = (t) => !t.agent_id && t.agent_launch?.state === "unstarted";
const archivedAgent = (snap) => Number.isFinite(Date.parse(snap?.archivedAt));

function launchLabels(project, t) {
  return { project: project.slug, role: "thread", thread: t.id };
}

function beginManagedLaunch(project, t) {
  const nonce = randomUUID();
  // Record uncertainty before the RPC. A missing acknowledgement never permits another launch.
  update(project, t.id, (r) => {
    r.agent_id = "";
    r.agent_launch = { state: "dispatched", nonce, project: project.slug };
  });
  return { ...launchLabels(project, t), pp_launch: nonce };
}

function recordManagedAgent(project, id, nonce, agentId, workspaceId) {
  return update(project, id, (r) => {
    if (r.agent_launch?.state !== "dispatched" || r.agent_launch.nonce !== nonce || r.agent_id) throw new Error("Agent launch record changed");
    r.agent_id = agentId;
    r.agent_launch.state = "confirmed";
    if (workspaceId) r.workspace_id = workspaceId;
  });
}

async function managedAgent(project, t, c, { readOnly = false } = {}) {
  const launch = t.agent_launch;
  const labels = { ...launchLabels(project, t), project: launch?.project, pp_launch: launch?.nonce };
  const matches = (snap) => snap?.cwd === t.cwd && (!launch || Object.entries(labels).every(([k, v]) => snap.labels?.[k] === v));
  let id = t.agent_id;
  if (!id) {
    // An old record without an attempt ID cannot distinguish earlier attempts from an in-flight one.
    if (launch?.state !== "dispatched" || !launch.nonce || !launch.project || !t.cwd) throw new Error("Agent launch unconfirmed; no exact launch attempt to reconcile");
    const { entries, pageInfo } = await c.agents.list({ filter: { labels }, page: { limit: 10 } });
    const candidates = entries.map(({ agent }) => agent).filter(matches);
    if (pageInfo?.hasMore !== false || candidates.length !== 1) throw new Error("Agent launch unconfirmed; no unique matching Agent");
    id = candidates[0].id;
  }
  const handle = c.agents.ref(id);
  await handle.refresh();
  const snap = handle.current();
  if (snap?.id !== id || !matches(snap)) throw new Error("Agent identity unconfirmed");
  if (!t.agent_id && !readOnly) t = recordManagedAgent(project, t.id, launch.nonce, id, snap.workspaceId);
  return { t, handle, snap };
}

async function archiveManagedAgent({ handle, snap }) {
  if (archivedAgent(snap)) return;
  const { archivedAt } = await handle.archive();
  if (!Number.isFinite(Date.parse(archivedAt))) throw new Error("Paseo did not confirm the archive");
  await handle.refresh();
  if (handle.current()?.id !== snap.id || !archivedAgent(handle.current())) throw new Error("Paseo did not confirm the archive of this Agent");
}

/** `thread start`: places the agent, writes the brief, sends the one-line prompt. */
export async function start(project, a) {
  return withLifecycleLock(project, () => startLocked(project, a));
}

async function startLocked(project, a) {
  const status = project.status;
  if (status !== "active") throw new Error(`\`${project.slug}\` is ${status}; \`thread start\` is refused until it is active again`);
  if (!a.title?.trim()) throw new Error("--title may not be empty");
  if (!a.task?.trim()) throw new Error("the task is empty");
  if (a.reviews !== undefined && !validPrUrl(a.reviews)) throw new Error("--reviews must be a https://github.com/<owner>/<repo>/pull/<number> URL");
  const { settings } = project.read();
  const config = loadConfig();
  const safety = loadSafety(config, project.dir);
  const machine = a.machine ?? "";
  if (machine && !a.repo) throw new Error("a remote thread needs --repo: a task with no repository runs as a folder thread in the project, which is local");
  const derive = a.from_snapshot !== undefined;
  const policy = settings.working_copy_policy ?? "git-worktree";
  if (!["git-worktree", "ovnfs-preferred"].includes(policy)) throw new Error("invalid working_copy_policy");
  const preferred = !a.kind && !derive && Boolean(a.repo) && policy === "ovnfs-preferred";
  let kind = a.kind ?? (derive || preferred ? "ovnfs" : a.repo ? "worktree" : "tab");
  if (!["worktree", "ovnfs", "tab", "checkout"].includes(kind)) throw new Error(`\`${kind}\` is not a thread kind (worktree, ovnfs, tab or checkout)`);
  if (derive && (kind !== "ovnfs" || a.base !== undefined)) throw new Error("--from-snapshot selects OVNFS and does not accept --base");
  if (a.inherit_dirty && (derive || a.base !== undefined || machine || !hasBranchCheckout({ kind }))) {
    throw new Error("--inherit-dirty requires a local worktree or OVNFS checkout at HEAD without --base or --from-snapshot");
  }
  if (kind !== "tab" && !a.repo && !derive) throw new Error(`a ${kind} thread needs --repo`);
  if (!preferred && kind !== "worktree" && machine) throw new Error(`a ${kind} thread runs locally; a remote repo needs a worktree thread`);
  const profile = resolveProfile(config, safety, settings, "thread", a.profile, project.slug);
  const h = host(machine, config), warnings = [];
  let ns, selection;
  if (kind === "ovnfs") {
    try {
      requireLocalPaseo();
      ns = managedOvnfs.preflight(h);
    } catch (e) {
      if (!preferred) throw e;
      kind = "worktree";
      selection = { policy, reason: e.message };
      warnings.push(`OVNFS preflight failed; fell back to git-worktree before allocation: ${selection.reason}`);
    }
  }
  if (a.repo && !settings.repos.some((r) => r.path.replace(/\/+$/, "") === a.repo.replace(/\/+$/, "") && (r.machine ?? "") === machine)) warnings.push(`${a.repo} is not one of the project's repos (\`set ${project.slug} repos.add\` lists it)`);
  const open = list(project).filter((t) => t.status !== "resolved").length;
  if (open >= settings.max_parallel_threads) warnings.push(`${open} threads are already open (max_parallel_threads is ${settings.max_parallel_threads})`);

  let repo = "", origin = "";
  const register = () => {
    const parent = derive ? snapshotSource(project, h, a.from_snapshot) : null;
    if (parent) managedOvnfs.requireSameNamespace(ns, parent.ovnfs.namespace);
    if (a.repo || parent) {
      repo = (a.repo ?? parent.source).replace(/\/+$/, "");
      const top = h.shell("git rev-parse --show-toplevel", repo);
      if (!top.ok) throw new Error(`${repo}${machine ? ` on ${machine}` : ""} is not a git repository: ${top.out}`);
      repo = top.stdout.trim();
      if (parent && repo !== parent.source) throw new Error("--repo does not match the OVNFS snapshot source");
      origin = h.shell("git remote get-url origin", repo).stdout.trim();
    }
    const baseline = parent?.baseline ?? (hasBranchCheckout({ kind }) ? workingCopy.gitBaseline(h, repo, a.base ?? "HEAD") : "");
    if (baseline) {
      if (kind === "worktree" && a.inherit_dirty) workingCopy.requireCleanCheckout(h, repo, baseline);
      const inputs = Boolean(a.inherit_dirty || (ns && !parent));
      admitWorkingCopy(project, h, { additions: inputs ? 2 : 1, repo: kind === "worktree" ? repo : undefined, namespace: ns, inputs });
    }
    return allocate(project, a.task, (t) => {
      Object.assign(t, { title: a.title.trim(), kind, repo, origin, machine, base: a.base ?? "", profile: profile.name, provider: profile.provider, ...(a.reviews ? { reviews: a.reviews } : {}) });
      if (hasBranchCheckout(t)) t.branch = branchName(project.slug, t.id, t.title);
      if (kind === "worktree") t.working_copy = workingCopy.plan(t, baseline);
      if (kind === "ovnfs") {
        t.working_copy = managedOvnfs.plan(t, baseline, ns, parent);
        if (!parent) t.working_copy.ovnfs.capture = capturePlan(project, t.working_copy);
      }
      if (a.inherit_dirty) t.working_copy.seed = capturePlan(project, t.working_copy);
      if (selection) t.working_copy.selection = selection;
      if (t.working_copy) t.agent_launch = { state: "unstarted" };
    });
  };
  let t = register();

  try {
    // Capture the explicitly selected dirty work before connecting to Paseo. Restart must never
    // substitute later source changes for the original intent, even if the daemon was down.
    if (t.working_copy?.seed) t = prepareInputs(project, t);
    const c = await client(h.url);
    const cwd = t.working_copy ? prepareWorkingCopy(project, t, h) : kind === "tab" ? project.path("threads", t.id) : kind === "ovnfs" ? ovnfsCwd(project, t) : repo;
    if (kind === "tab") mkdirSync(cwd, { recursive: true });
    const ws = kind === "checkout" ? null : await tabWorkspace(c, cwd, repo, t.title, h.remote);
    if (t.working_copy) verifyWorkingCopy(h, load(project, t.id));
    const cfg = agentConfig(profile, safety);
    const labels = t.working_copy ? beginManagedLaunch(project, t) : launchLabels(project, t);
    const handle = await (ws ? ws.agents : c.agents).create({
      config: cfg,
      cwd,
      title: `${project.displayName(settings)} · ${t.id} ${t.title}`.slice(0, 120),
      labels,
      env: machine ? undefined : { PP_THREAD: `${project.slug}/${t.id}` },
    });
    if (t.working_copy) recordManagedAgent(project, t.id, labels.pp_launch, handle.id, ws?.id);
    await handle.refresh();
    const snap = handle.current();
    const placed = update(project, t.id, (r) => Object.assign(r, {
      agent_id: handle.id, workspace_id: snap?.workspaceId ?? ws?.id ?? "", cwd: t.working_copy || kind === "ovnfs" ? cwd : snap?.cwd ?? cwd, branch: t.branch,
    }));
    if (placed.working_copy) {
      if (snap?.cwd !== cwd) throw new Error(`Paseo did not confirm the agent at its worktree ${cwd}`);
      verifyWorkingCopy(h, placed);
    }
    placed.thread_dir = threadDir(placed.cwd, project.slug, t.id);
    update(project, t.id, (r) => { r.thread_dir = placed.thread_dir; });
    writeBrief(project, placed, false);
    refreshBranch(project, placed);
    await handle.send(launchPrompt(project.slug, t.id));
    return { thread: update(project, t.id, (r) => { r.status = "open"; r.error = ""; }), warnings };
  } catch (e) {
    update(project, t.id, (r) => { r.status = "failed"; r.error = e.message; });
    throw new Error(`${selection ? `${warnings[0]}; ` : ""}${t.id} did not start: ${e.message}; \`thread restart ${project.slug} ${t.id}\` tries again`);
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
export async function restart(project, id, requested, opts) {
  return withLifecycleLock(project, () => restartLocked(project, id, requested, opts));
}

async function restartLocked(project, id, requested, opts = {}) {
  let t = load(project, id);
  if (t.status === "resolved") throw new Error(`${id} is resolved; \`thread resolve --reopen\` first`);
  if (t.status === "starting" && secondsSince(t.launch_started ?? t.created) < STARTING_TIMEOUT_SECS) throw new Error(`${id} is still starting`);
  const { settings } = project.read();
  const config = loadConfig();
  const safety = loadSafety(config, project.dir);
  const profile = resolveProfile(config, safety, settings, "thread", requested || t.profile, project.slug);
  const h = host(t.machine, config);
  const c = await client(h.url);
  const managed = Boolean(t.working_copy);
  const agents = managed ? new Map() : await agentsOf(project, new Set([t.machine]));
  const prior = managed && !neverDispatchedAgent(t) ? await managedAgent(project, t, c) : null;
  if (prior) t = prior.t;
  const live = liveOf(t, prior?.snap ?? agents.get(t.agent_id), null);
  const interrupted = t.status === "failed" || t.status === "starting";
  if (live.exists && live.state !== "error" && !(managed && interrupted && live.state === "idle")) {
    throw new Error(`${id} is running: it has an agent (${live.state}); \`thread prompt\` reaches it`);
  }
  if (!managed) return restartAt(project, t, h, c, agents, settings, safety, profile, opts);
  update(project, id, (r) => {
    if (r.status !== t.status || r.agent_id !== t.agent_id || r.launch_started !== t.launch_started) throw new Error(`${id} changed during restart; try again`);
    r.status = "starting";
    r.launch_started = now();
  });
  try { return await restartAt(project, t, h, c, agents, settings, safety, profile, opts, prior); }
  catch (e) {
    update(project, id, (r) => { r.status = "failed"; r.error = e.message; });
    throw e;
  }
}

async function restartAt(project, t, h, c, agents, settings, safety, profile, opts, prior) {
  const { id } = t;
  let cwd = t.cwd, worktree;
  if (t.working_copy) {
    cwd = prepareWorkingCopy(project, t, h);
    if (prior) await archiveManagedAgent(prior);
  } else if (t.kind === "ovnfs") {
    requireLocalPaseo();
    cwd = ovnfsCwd(project, t);
  }
  if (!t.working_copy && t.agent_id && agents.has(t.agent_id)) await c.agents.ref(t.agent_id).archive().catch(() => {});

  if (t.kind === "tab") { cwd = project.path("threads", id); mkdirSync(cwd, { recursive: true }); }
  else if (!t.working_copy && (!cwd || !h.isDir(cwd))) {
    if (t.kind !== "worktree") throw new Error(`${t.repo} is gone`);
    if (!t.branch || !h.shell(`git show-ref --verify --quiet ${q(`refs/heads/${t.branch}`)}`, t.repo).ok) throw new Error(`${id}'s worktree and branch are both gone; start a new thread`);
    cwd = t.repo;
    worktree = { mode: "checkout-branch", branch: t.branch };
  }
  // A session belongs to its folder: a new worktree cannot pick it up.
  if (worktree && opts.session) throw new Error(`${id}'s worktree is gone, so its session cannot be picked up; restart without --session`);
  const session = worktree ? null : sessionFor(t, prior?.snap ?? agents.get(t.agent_id), kindOf(profile), opts);
  const cfg = agentConfig(profile, safety);
  const title = `${project.displayName(settings)} · ${id} ${t.title}`.slice(0, 120);
  const ws = t.working_copy || t.kind === "tab" || t.kind === "ovnfs" ? await tabWorkspace(c, cwd, t.repo, t.title, h.remote) : null;
  if (t.working_copy) verifyWorkingCopy(h, load(project, id));
  const labels = t.working_copy ? beginManagedLaunch(project, t) : launchLabels(project, t);
  let handle;
  if (session) {
    // shortcut: an imported agent has no PP_THREAD; the brief's `report` command names the thread anyway.
    try {
      const a = await importSession(h.url, { provider: session.provider, sessionId: session.id, cwd, workspaceId: ws?.id, labels, model: modelOf(profile), modeId: cfg.modeId, title });
      handle = c.agents.ref(a.id);
    } catch (e) {
      const next = t.working_copy ? "Agent launch is unconfirmed; another launch requires exact reconciliation"
        : `\`thread restart ${project.slug} ${id} --fresh\` starts a new one`;
      throw new Error(`${id}: session ${session.id} could not be picked up (${e.message}); ${next}`);
    }
  } else {
    handle = await (ws ? ws.agents : c.agents).create({
      config: cfg, cwd, title, labels,
      env: t.machine ? undefined : { PP_THREAD: `${project.slug}/${id}` },
      ...(worktree ? { worktree } : {}),
    });
  }
  if (t.working_copy) recordManagedAgent(project, id, labels.pp_launch, handle.id, ws?.id);
  await handle.refresh();
  const snap = handle.current();
  const placed = update(project, id, (r) => Object.assign(r, {
    agent_id: handle.id, workspace_id: snap?.workspaceId ?? ws?.id ?? r.workspace_id, cwd: t.working_copy || t.kind === "ovnfs" ? cwd : snap?.cwd ?? cwd,
    profile: profile.name, provider: profile.provider, session,
    ...(t.working_copy ? {} : { status: "open", error: "" }),
  }));
  if (placed.working_copy) {
    if (snap?.cwd !== cwd) throw new Error(`Paseo did not confirm the agent at its worktree ${cwd}`);
    verifyWorkingCopy(h, placed);
  }
  placed.thread_dir = threadDir(placed.cwd, project.slug, id);
  update(project, id, (r) => { r.thread_dir = placed.thread_dir; });
  carryReport(h, t.thread_dir, placed.thread_dir, readText(homeReportPath(project, id)));
  writeBrief(project, placed, true);
  if (placed.working_copy) refreshBranch(project, placed);
  await handle.send(launchPrompt(project.slug, id));
  return placed.working_copy ? update(project, id, (r) => { r.status = "open"; r.error = ""; }) : placed;
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
  if (t.working_copy) {
    if (snap.cwd !== t.cwd) throw new Error(`Paseo did not confirm the agent at its worktree ${t.cwd}`);
    verifyWorkingCopy(host(t.machine), t);
  }
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
  if (t.working_copy && behavior === "allow") {
    if (snap.cwd !== t.cwd) throw new Error(`Paseo did not confirm the agent at its worktree ${t.cwd}`);
    verifyWorkingCopy(host(t.machine), t);
  }
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
  if (!hasBranchCheckout(t) || !t.cwd) return t;
  try {
    const h = host(t.machine);
    if (t.working_copy) verifyWorkingCopy(h, t);
    const r = h.shell("git branch --show-current", t.cwd, undefined, 5000);
    const b = r.ok ? r.stdout.trim() : "";
    if (b && b !== t.branch) return update(project, t.id, (x) => { x.branch = b; });
  } catch {}
  return t;
}

async function archiveWorkspace(url, id) {
  try {
    const c = await client(url);
    const { archivedAt, error } = await c.workspaces.archive(id);
    if (error || !archivedAt) throw new Error(error ?? "Paseo did not confirm the archive");
    return "Paseo workspace archived";
  } catch (e) {
    return `Paseo workspace not archived: ${e.message}`;
  }
}

/**
 * Archives the agent, then runs cleanup: declared discards, the worktree (never forced), and its indexes.
 * A worktree workspace is archived only once the worktree is gone: Paseo's archive can delete it.
 */
const resourcesOf = (t) => [t.working_copy, ...(Array.isArray(t.working_copies) ? t.working_copies : [])].filter(Boolean);
const removedResource = (w) => w.phase === "removed" && w.disposal?.phase === "removed";
export const pendingDisposal = (t) => t.status === "resolved" && resourcesOf(t).some((w) => !removedResource(w));
const legacyHold = (r) => Object.hasOwn(r, "kept_worktree") && r.kept_worktree !== false;

function utcDeadline(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value.replace(/(?<!\.\d{3})Z$/, ".000Z") ? at : NaN;
}

function holdBlocker(project, t, w) {
  if ([t, w].some((r) => legacyHold(r) && r.kept_worktree !== true)) return "legacy hold is unknown; only a person can release it";
  if (legacyHold(t) || legacyHold(w)) return "explicit --keep-worktree hold (legacy)";
  if (!Object.hasOwn(w, "hold")) return "";
  const hold = w.hold;
  const validReason = typeof hold?.reason === "string" && hold.reason.trim();
  if (validReason && Object.keys(hold).length === 2) {
    if (hold.indefinite === true) return `indefinite hold: ${hold.reason}`;
    const at = utcDeadline(hold.until);
    if (Number.isFinite(at)) return at <= Date.now() ? "" : `hold: ${hold.reason} (until ${hold.until})`;
    if (hold.until_resolved && hold.until_resolved !== t.id) {
      try {
        const other = load(project, hold.until_resolved);
        if (other.id === hold.until_resolved && other.status === "resolved") return "";
        if (other.id === hold.until_resolved && ["open", "starting"].includes(other.status)) return `hold: ${hold.reason} (until ${other.id} resolves)`;
      } catch {}
    }
  }
  return "hold is unknown; only a person can release it";
}

export const legacyCleanupBlocker = (project, t) => isLegacy(t) && t.kind === "worktree" && t.status === "resolved"
  ? cleanup.blockedLegacyWorktree(project, t)?.reason ?? "" : "";

function reconciliationRows(project, listed) {
  const blocked = new Map(listed.map((t) => [t.id, legacyCleanupBlocker(project, t)]));
  return discover(project, listed).items.map((w) => {
    const blocker = blocked.get(w.owner);
    if (!blocker) return w;
    const retry = `thread cleanup ${project.slug} ${w.owner}`;
    return { ...w, disposal: { phase: "blocked", blocker }, blockers: [...w.blockers, blocker],
      actions: [...w.actions, `preview: ${retry} --dry-run`, `explicit retry: ${retry}`] };
  });
}

export const reconciliation = (project) => reconciliationRows(project, list(project));

export function boardResources(project) {
  const listed = list(project), pending = reconciliationRows(project, listed);
  for (const t of listed) {
    if (pendingDisposal(t)) {
      const { working_copy, working_copies } = resourceView(project, t, pending);
      for (const w of [working_copy, ...working_copies].filter((w) => w && !removedResource(w))) {
        const { owner, backend, path, source, machine, baseline, blockers, actions } = w;
        pending.push({ project: project.slug, owner, backend, path, source, machine, baseline, blockers, actions,
          candidate: "", resource: w.resource ?? w.nonce, phase: w.disposal?.phase ?? w.phase });
      }
    }
    const w = t.working_copy, blocker = w?.adoption && removedResource(w) && branchIdentityBlocker(t);
    if (!blocker) continue;
    const blockers = [blocker];
    let phase = "retained";
    try { if (!workingCopy.hasGitBranch(w.source, t.branch)) continue; }
    catch { phase = "unknown"; blockers.push("the recorded branch could not be read"); }
    pending.push({ project: project.slug, owner: t.id, backend: w.backend, path: "", source: w.source, machine: w.machine,
      branch: t.branch, blockers, actions: [], candidate: "", phase });
  }
  return pending;
}

export function adopt(project, id, candidate, base) {
  requirePerson("thread adopt");
  if (!/^[a-f0-9]{64}$/.test(candidate ?? "") || !workingCopy.commitOid.test(base ?? "")) throw new Error("adoption requires --candidate from thread discover and a full --base OID");
  return withLifecycleLock(project, () => {
    const t = load(project, id);
    const selected = discover(project, list(project)).candidates.get(candidate);
    if (!selected) throw new Error(`resource candidate is no longer verified; ${workingCopy.preserveUnmanagedGit}; rerun thread discover to review its blockers`);
    if (selected.baseline !== base) throw new Error(`--base does not match the Git registration's original checkout commit; ${workingCopy.preserveUnmanagedGit}`);
    if (t.id !== id || t.machine || t.repo !== selected.source || !["open", "resolved"].includes(t.status) ||
        (selected.owner ? selected.owner !== id : !t.working_copy)) {
      throw new Error("resource cannot be assigned to this thread; choose its historical owner or a managed thread for the same local source");
    }
    const w = { ...selected, owner: id, machine: t.machine ?? "", phase: "ready", nonce: randomUUID(), blocker: "", depends_on: [],
      adoption: { at: now(), origin: { kind: "git-worktree-initial-commit", source: selected.source, commit: base } } };
    update(project, id, (r) => {
      if (selected.owner) r.working_copy = w;
      else (r.working_copies ??= []).push(w);
    });
    return w;
  });
}

export function resourceView(project, t, discovery) {
  const retry = `thread cleanup ${project.slug} ${t.id}`;
  const view = (w) => {
    const { disposal } = w;
    const hold = removedResource(w) ? "" : holdBlocker(project, t, w);
    const check = disposal?.hold_blocker === disposal?.blocker ? disposal?.check_blocker : disposal?.blocker;
    const blockers = [...new Set([hold, w.blocker, check, w === t.working_copy && branchIdentityBlocker(t)].filter(Boolean))];
    const actions = [];
    if (hold) actions.push(`person: thread release ${project.slug} ${t.id}${legacyHold(t) ? "" : ` --resource ${w.nonce}`}`);
    if (t.status === "resolved" && !removedResource(w)) {
      if (w.backend !== "ovnfs") actions.push(`preview: ${retry} --dry-run`, `retry: ${retry}`);
      else if (!hold && w.phase === "ready" && w.ovnfs && !w.ovnfs.label) {
        actions.push(`explicit: pp thread delete-checkout ${project.slug} ${t.id}${w === t.working_copy ? "" : ` --resource ${w.resource}`}`);
      }
    }
    const retained_input = w.ovnfs?.capture || w.seed ? {
      path: (w.ovnfs?.capture ?? w.seed).path,
      reason: w.ovnfs?.capture
        ? `kept as an OVNFS Git object dependency${w.seed ? " and an independent dirty seed" : ""}; not eligible for automatic removal`
        : "kept as the independent dirty seed; not eligible for automatic removal",
    } : undefined;
    return { ...w, blockers, actions, ...(retained_input ? { retained_input } : {}) };
  };
  return { working_copy: t.working_copy ? view(t.working_copy) : null,
    working_copies: resourcesOf({ working_copies: t.working_copies }).map(view),
    reconciliation: isLegacy(t) ? (discovery ?? reconciliation(project)).filter((w) => w.owner === t.id) : [] };
}

function cleanupException(project, t, w, reason) {
  if (!reason) return;
  const key = `${w.nonce}:${reason.replace(/occupied by process \d+/g, "occupied by process").replace(/\bcommit [a-f0-9]{40,64}\b/g, "commit")}`;
  inbox.write(project, "cleanup", t.id, "resource retained", `${t.id} ${w.backend} ${w.path || w.nonce}: ${reason}; thread cleanup ${project.slug} ${t.id} retries`, "", key);
}

function selectedResource(t, nonce) {
  const matches = nonce === undefined ? [t.working_copy].filter(Boolean) : resourcesOf(t).filter((w) => w.nonce === nonce);
  if (matches.length !== 1 || matches[0].owner !== t.id) throw new Error("managed resource is missing or ambiguous");
  return matches[0];
}

export function hold(project, id, options) {
  return withLifecycleLock(project, () => holdLocked(project, id, options));
}

function holdLocked(project, id, { resource, reason, until, untilResolved, indefinite }) {
  if (typeof reason !== "string" || !reason.trim()) throw new Error("a hold requires a reason");
  if ([until !== undefined, untilResolved !== undefined, Boolean(indefinite)].filter(Boolean).length !== 1) {
    throw new Error("a hold requires one deadline or condition; a person can request --indefinite");
  }
  let constraint;
  if (indefinite) {
    requirePerson("thread hold --indefinite");
    constraint = { indefinite: true };
  } else if (untilResolved !== undefined) {
    const other = load(project, untilResolved);
    if (other.id !== untilResolved || other.id === id || !["open", "starting"].includes(other.status)) throw new Error("condition must name another unresolved thread in this project");
    constraint = { until_resolved: other.id };
  } else {
    const at = utcDeadline(until);
    if (!(at > Date.now())) throw new Error("hold --until requires a valid future UTC deadline");
    constraint = { until: new Date(at).toISOString() };
  }
  return update(project, id, (t) => {
    const w = selectedResource(t, resource);
    if (w.phase === "removed" || ["removing", "unknown", "removed"].includes(w.disposal?.phase)) throw new Error("resource removal is complete or unconfirmed");
    if (holdBlocker(project, t, w)) throw new Error("resource has an active hold; only a person can release it first");
    w.hold = { reason: reason.trim(), ...constraint };
  });
}

export function release(project, id, nonce) {
  requirePerson("thread release");
  return withLifecycleLock(project, () => update(project, id, (t) => {
    const w = selectedResource(t, nonce);
    delete w.hold;
    delete w.kept_worktree;
    if (nonce === undefined) t.kept_worktree = false;
  }));
}

export function deleteCheckout(project, id, resource = "main") {
  return withLifecycleLock(project, async () => {
    const t = load(project, id);
    if (t.status !== "resolved") throw new Error(`${id} is not resolved`);
    if (t.kind !== "ovnfs" || t.working_copy?.backend !== "ovnfs") throw new Error("checkout deletion requires a managed OVNFS thread, not a legacy or external checkout");
    const matches = resource === "main" ? [workingCopyRecord(t)] : (t.working_copies ?? []).filter((w) => w.resource === resource);
    const [w] = matches;
    if (matches.length !== 1 || w.owner !== id || w.machine !== t.machine || w.backend !== "ovnfs" || !w.ovnfs || w.ovnfs.label) {
      throw new Error(`no exact owned OVNFS checkout named ${resource}; snapshots are not deletable`);
    }
    if (removedResource(w)) return `OVNFS checkout already removed: ${w.path}`;
    if (w.phase !== "ready" || !w.identity || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(w.nonce)) throw new Error("OVNFS checkout identity is not confirmed");
    const hold = holdBlocker(project, t, w);
    if (hold) throw new Error(hold);
    const h = host(t.machine);
    if (h.remote) throw new Error("checkout deletion requires a local OVNFS checkout");
    requireLocalPaseo();
    let archived = t;
    if (!neverDispatchedAgent(t)) {
      const prior = await managedAgent(project, t, await client(h.url)).catch((e) => {
        throw new Error(`agent archive unconfirmed: ${e.message}`);
      });
      if (!archivedAgent(prior.snap)) throw new Error("agent archive unconfirmed");
      archived = prior.t;
    }
    return deleteOvnfsCheckout(project, t, h, w, (disposal) => update(project, id, (r) => {
      const current = resourcesOf(r).find((row) => row.nonce === w.nonce);
      if (r.status !== "resolved" || current?.path !== w.path || r.agent_id !== archived.agent_id || r.agent_launch?.state !== archived.agent_launch?.state || holdBlocker(project, r, current)) {
        throw new Error("thread, resource or hold changed during deletion");
      }
      current.disposal = disposal;
      if (disposal.phase === "removed") current.phase = "removed";
    }));
  });
}

const unconfirmedAllocation = (w) => w && !w.identity && ["planned", "creating"].includes(w.phase);
const allocationBlocker = "working-copy allocation is unconfirmed; retained without copying or deleting";

async function clean(project, t, { keepWorktree = false, copyComplete = true, archive, mergedHead = "", dryRun = false, scheduled = false } = {}) {
  if (unconfirmedAllocation(t.working_copy)) return [allocationBlocker];
  const notes = [];
  let h;
  try { h = host(t.machine); }
  catch (e) { return [e.message]; }
  let legacyGit;
  if (isLegacy(t) && t.kind === "worktree") {
    legacyGit = () => verifyLegacyGit(project, t);
    try { legacyGit(); }
    catch { return (await cleanup.run(project, t, h, { archive, dryRun, legacyGit })).notes; }
  }
  if (isLegacy(t) && t.kind === "ovnfs" && t.cwd) {
    try { ovnfs.mounted(t); }
    catch { return (await cleanup.run(project, t, h, { archive, dryRun })).notes; }
  }
  const managed = Boolean(t.working_copy);
  const readOnlyOvnfs = managed && t.kind === "ovnfs" && scheduled;
  let agentArchived = dryRun || (managed ? neverDispatchedAgent(t) : !t.agent_id);
  if (!agentArchived) {
    try {
      if (t.kind === "ovnfs") requireLocalPaseo();
      const c = await client(h.url);
      if (managed) {
        const prior = await managedAgent(project, t, c, { readOnly: readOnlyOvnfs });
        t = prior.t;
        if (readOnlyOvnfs) {
          if (!archivedAgent(prior.snap)) throw new Error("agent archive unconfirmed; run thread cleanup explicitly");
        } else await archiveManagedAgent(prior);
      } else {
        const { archivedAt } = await c.agents.ref(t.agent_id).archive();
        if (!archivedAt) throw new Error("Paseo did not confirm the archive");
      }
      agentArchived = true;
      if (!readOnlyOvnfs) notes.push("agent archived");
    } catch (e) {
      notes.push(`agent not archived: ${e.message}`);
    }
  }
  // Only a tab's workspace can be archived while keeping its checkout.
  if (t.kind === "tab" && t.workspace_id && !dryRun) notes.push(await archiveWorkspace(h.url, t.workspace_id));
  // Paseo's merge auto-archive removes a workspace's worktree whatever pp keeps, so a kept one says so (or that it is unknown).
  const paseoAutoArchive = t.kind === "worktree" && t.workspace_id ? await autoArchiveAfterMerge(h.url) : { on: false };
  const refreshArchive = t.kind === "ovnfs" ? () => finalCopy(project, t) : undefined;
  let done;
  try {
    if (t.working_copy) {
      const resources = [workingCopyRecord(t), ...(t.working_copies ?? [])];
      const results = resources.map((w, i) => {
        try {
          const hold = holdBlocker(project, t, w);
          const result = dispose(project, t, h, w, { keepWorktree, agentArchived, dryRun, scheduled, holdBlocker: hold, save: (disposal) => update(project, t.id, (r) => {
            const current = i === 0 ? workingCopyRecord(r) : r.working_copies?.[i - 1];
            if (r.status !== "resolved" || current?.nonce !== w.nonce || current.path !== w.path) throw new Error("thread or resource changed during disposal");
            if (disposal.phase === "removing" && holdBlocker(project, r, current)) throw new Error("resource still has a hold");
            current.disposal = disposal;
            if (disposal.phase === "removed") current.phase = "removed";
          }) });
          if (!dryRun && !result.gone) {
            const r = load(project, t.id);
            const disposal = (i === 0 ? r.working_copy : r.working_copies?.[i - 1])?.disposal;
            const reason = disposal?.check_blocker ?? disposal?.blocker;
            if (w.backend !== "ovnfs" && reason && reason !== hold) cleanupException(project, t, w, reason);
            if (w.backend !== "ovnfs" && hold.includes("hold is unknown;")) cleanupException(project, t, w, hold);
          }
          return result;
        } catch (e) {
          if (!dryRun && w.backend !== "ovnfs") cleanupException(project, t, w, e.message);
          return { gone: false, note: `resource cleanup failed: ${e.message}` };
        }
      });
      done = { notes: results.map((r) => r.note), worktreeGone: results.every((r) => r.gone) };
      if (!done.worktreeGone && t.workspace_id && paseoAutoArchive.on !== false) {
        done.notes.push(paseoAutoArchive.on ? "Paseo merge auto-archive is on and can remove the worktree" : "Paseo merge auto-archive is unknown");
      }
    } else done = await cleanup.run(project, t, h, { keepWorktree, copyComplete, archive, refreshArchive, agentArchived, dryRun, paseoAutoArchive, legacyGit });
  }
  catch (e) { return [...notes, `cleanup failed: ${e.message}; \`thread cleanup ${project.slug} ${t.id}\` retries`]; }
  notes.push(...done.notes);
  const branchBlocker = branchIdentityBlocker(t);
  if (branchBlocker && (mergedHead || t.resolved_reason === "reviewed PR merged")) notes.push(`branch ${t.branch} kept: ${branchBlocker}`);
  if (dryRun || t.kind !== "worktree") return notes;
  if (!done.worktreeGone) {
    if (t.workspace_id) notes.push("Paseo workspace kept: archiving it could delete the worktree");
    return notes;
  }
  if (t.workspace_id) notes.push(await archiveWorkspace(h.url, t.workspace_id));
  if (branchBlocker) return notes;
  if (mergedHead && t.branch) {
    const tip = h.shell(`git rev-parse --verify -q ${q(`refs/heads/${t.branch}`)}`, t.repo);
    if (!tip.ok) notes.push("no local branch left");
    else if (tip.stdout.trim() !== mergedHead) notes.push(`branch ${t.branch} kept: it has commits that are not in the merged pull request`);
    else { const d = h.shell(`git branch -D -- ${q(t.branch)}`, t.repo); notes.push(d.ok ? `branch ${t.branch} deleted` : `branch kept: ${d.out}`); }
  } else if (t.resolved_reason === "reviewed PR merged" && t.branch) {
    notes.push(cleanReviewBranch(h, t));
  }
  return notes;
}

function cleanReviewBranch(h, t) {
  const ref = `refs/heads/${t.branch}`;
  const tip = h.shell(`git rev-parse --verify -q ${q(ref)}`, t.repo);
  if (tip.code === 1) return "no local branch left";
  if (!tip.ok) return `branch ${t.branch} kept: could not read its tip (${tip.out})`;
  if (t.branch_start?.name !== t.branch || !t.branch_start.oid) {
    return `branch ${t.branch} kept: its original branch and starting commit could not be verified`;
  }
  if (tip.stdout.trim() !== t.branch_start.oid) {
    return `branch ${t.branch} kept: it has its own commits or moved since creation`;
  }
  const otherRefs = h.shell(`git for-each-ref --contains ${q(t.branch_start.oid)} --format='%(refname)' refs/heads refs/remotes refs/tags`, t.repo);
  if (!otherRefs.ok || !otherRefs.stdout.trim().split("\n").some((name) => name && name !== ref)) {
    return `branch ${t.branch} kept: its starting commit is not known to be reachable from another ref`;
  }
  const worktrees = h.shell("git worktree list --porcelain", t.repo);
  if (!worktrees.ok) return `branch ${t.branch} kept: could not list its worktrees (${worktrees.out})`;
  if (worktrees.stdout.split("\n").includes(`branch ${ref}`)) return `branch ${t.branch} kept: it is checked out`;
  // An intervening commit must survive, even if the branch was unchanged during the checks above.
  const deleted = h.shell(`git update-ref --no-deref -d ${q(ref)} ${q(t.branch_start.oid)}`, t.repo);
  return deleted.ok ? `branch ${t.branch} deleted` : `branch ${t.branch} kept: ${deleted.out}`;
}

/** Final copy, then resolved, then cleanup, then one inbox item. */
export async function resolve(project, id, options) {
  return withLifecycleLock(project, () => resolveLocked(project, id, options));
}

async function resolveLocked(project, id, { keepWorktree = false, force = false, skipCopy = false, reason = "user", mergedHead = "", why } = {}) {
  let t = load(project, id);
  if (t.status === "resolved") throw new Error(`${id} is already resolved; \`thread cleanup ${project.slug} ${id}\` cleans what is left of it`);
  const resolveWithoutCheckout = unconfirmedAllocation(t.working_copy) && reason === "user" && skipCopy;
  if (t.working_copy) {
    if (keepWorktree) requirePerson("thread resolve --keep-worktree");
    if (resolveWithoutCheckout) workingCopyRecord(t);
    else verifyWorkingCopy(host(t.machine), t);
  }
  const retainLegacy = reason !== "user" && isLegacy(t);
  if (!isLegacy(t) && !resolveWithoutCheckout) t = refreshBranch(project, t);
  let copied = { outcome: "complete", notes: [] };
  if (!skipCopy && !retainLegacy) {
    copied = finalCopy(project, t);
    if (copied.outcome === "failed") throw new Error(`the final copy failed (${copied.error}); not resolving. \`--skip-copy\` resolves without it.`);
  }
  const resolved = update(project, id, (r) => {
    r.status = "resolved"; r.resolved_reason = reason;
    if (keepWorktree || (!resourcesOf(r).length && !isLegacy(r))) r.kept_worktree = keepWorktree;
    if (copied.hash) r.report_hash = copied.hash;
    if (resolveWithoutCheckout) r.working_copy.disposal = { phase: "retained", blocker: allocationBlocker };
  });
  const notes = resolveWithoutCheckout ? [allocationBlocker] : retainLegacy ? ["legacy resource retained pending confirmation; background resolution does not clean it"] :
    [...copied.notes, ...(await clean(project, resolved, { keepWorktree: keepWorktree || (isLegacy(resolved) && legacyHold(resolved)), copyComplete: copied.outcome === "complete" || force, archive: skipCopy ? { outcome: "skipped" } : copied, mergedHead }))];
  inbox.write(project, "thread-state", id, "resolved", `${id} "${t.title}" ${why ?? "was resolved"}: ${notes.join("; ")}`);
  return notes;
}

/** Report and library home, less the library paths the thread declared disposable. */
function finalCopy(project, t) {
  if (isLegacy(t) && t.kind === "worktree") {
    try { verifyLegacyGit(project, t); }
    catch { return { outcome: "unknown", notes: [`legacy worktree copy skipped: the historical PP registration could not be verified; ${workingCopy.preserveUnmanagedGit}`], unknown: ["report", "library"] }; }
  }
  if (t.kind === "ovnfs" && !t.working_copy && t.cwd) {
    try { ovnfs.mounted(t); }
    catch (e) { return { outcome: "failed", notes: [], error: e.message }; }
  }
  if (t.working_copy) {
    try { verifyWorkingCopy(host(t.machine), t); }
    catch (e) { return { outcome: "failed", notes: [], error: e.message }; }
  }
  let excludes = [];
  try { excludes = t.machine ? [] : cleanup.libraryExcludes(project, t, host(t.machine)); } catch {}
  return copyHome(project, t, true, excludes);
}

/** `thread cleanup`: copy home again, then the same cleanup for a resolved thread; `dryRun` previews any thread. */
export async function cleanupAgain(project, id, options) {
  return withLifecycleLock(project, () => cleanupLocked(project, id, options));
}

async function cleanupLocked(project, id, { dryRun = false, scheduled = false } = {}) {
  const t = load(project, id);
  if (scheduled && !pendingDisposal(t)) return [];
  if (t.status !== "resolved" && !dryRun) throw new Error(`${id} is not resolved; \`thread resolve\` cleans up (\`thread cleanup --dry-run\` previews)`);
  let copied;
  const notes = [];
  // Disposal preserves current evidence independently; a background retry must not overwrite home copies.
  if (!dryRun && !scheduled && t.working_copy?.phase !== "removed") {
    copied = finalCopy(project, t);
    notes.push(...copied.notes, ...(copied.error ? [`the copy home failed: ${copied.error}`] : []));
  } else if (dryRun) notes.push("preview: assumes the final copy completes");
  const mergedHead = t.kind === "ovnfs" && t.resolved_reason === "merged" && t.pr_summary?.state === "MERGED" ? t.pr_summary.head_oid : "";
  return [...notes, ...(await clean(project, t, { keepWorktree: t.status === "resolved" && legacyHold(t), copyComplete: !copied || copied.outcome === "complete", archive: copied, mergedHead, dryRun, scheduled }))];
}

export function reopen(project, id) {
  return withLifecycleLock(project, () => update(project, id, (t) => {
    if (t.status !== "resolved") throw new Error(`${id} is not resolved`);
    t.status = "open";
    t.resolved_reason = "";
  }));
}

// ------------------------------------------------------------ printing

export function rowJson(project, row, discovery) {
  return { ...row.t, ...resourceView(project, row.t, discovery), group: row.group, group_label: GROUPS[row.group].label, note: row.note, state: row.live.state, progress: row.live.progress, next: allNext(project, row.t.id), report: homeReportPath(project, row.t.id) };
}

export function rowLine(row) {
  const t = row.t;
  return `${t.id} [${GROUPS[row.group].label}] (${row.note}) ${t.title} — ${t.repo ? `${t.repo}${t.machine ? ` on ${t.machine}` : ""}` : "no repo"} — ${t.profile || t.provider}`;
}

export const isOpen = (t) => t.status !== "resolved";
export const sortRows = (rs) => rs.sort((a, b) => GROUPS[a.group].rank - GROUPS[b.group].rank || a.t.id.localeCompare(b.t.id));
