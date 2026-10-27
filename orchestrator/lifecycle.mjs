// Project lifecycle: pause, archive, delete, rename; sweep and doctor.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { client, sh, readText, readJson, writeJson, isFile, isDir, secondsSince } from "./lib.mjs";
import { CONFIG_PATH, canonical, loadConfig, moveApprovals } from "./config.mjs";
import { Project, SUBDIRS, TASKS_TEMPLATE, writeAgentsMd, writeSettings, listSlugs } from "./project.mjs";
import * as threads from "./threads.mjs";
import * as inbox from "./inbox.mjs";
import * as ticker from "./ticker.mjs";

/** Every agent Paseo has for a project (thread and coordinator), not archived. */
async function liveAgents(project) {
  const c = await client();
  const r = await c.agents.list({ filter: { labels: { project: project.slug } } });
  return r.entries.map((e) => e.agent).filter((a) => !a.archivedAt && a.status !== "closed" && ["thread", "coordinator"].includes(a.labels?.role));
}

async function archiveAgents(project) {
  const c = await client();
  const agents = await liveAgents(project);
  for (const a of agents) await c.agents.ref(a.id).archive().catch(() => {});
  return agents.length;
}

export function pause(project) { project.setState({ status: "paused" }); }
export function resume(project) { project.setState({ status: "active" }); }

export async function archive(project) {
  project.setState({ status: "archived" });
  return archiveAgents(project);
}
export function unarchive(project) { project.setState({ status: "active" }); }

/** Moves the folder to <root>/.trash/<slug>-<stamp>. */
export async function remove(project, force) {
  const agents = await liveAgents(project);
  if (agents.length && !force) throw new Error(`${agents.length} agent(s) of \`${project.slug}\` are alive; \`delete --force\` archives them first`);
  await archiveAgents(project);
  const trash = join(project.root, ".trash");
  mkdirSync(trash, { recursive: true });
  const target = join(trash, `${project.slug}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}`);
  renameSync(project.dir, target);
  return target;
}

/** New slug: folder, former slugs, approvals, safety table. The coordinator is archived. */
export async function rename(project, newSlug, { name, dryRun = false } = {}) {
  const target = new Project(project.root, newSlug);
  if (existsSync(target.dir)) throw new Error(`${target.dir} already exists`);
  const unresolved = threads.list(project).filter(threads.isOpen);
  if (unresolved.length) throw new Error(`threads not resolved: ${unresolved.map((t) => t.id).join(", ")}; resolve them first`);
  const plan = [`move ${project.dir} → ${target.dir}`, "archive the coordinator", "move routine approvals and the safety table", ...(name ? [`set name to "${name}"`] : []), `\`open ${newSlug}\` starts a new coordinator`];
  if (dryRun) return plan;
  await archiveAgents(project);
  const oldCanon = canonical(project.dir);
  renameSync(project.dir, target.dir);
  const newCanon = canonical(target.dir);
  target.setState({ former_slugs: [...new Set([...target.state().former_slugs, project.slug])] });
  moveApprovals(oldCanon, newCanon);
  const raw = readJson(CONFIG_PATH, null);
  if (raw?.safety?.[oldCanon]) { raw.safety[newCanon] = raw.safety[oldCanon]; delete raw.safety[oldCanon]; writeJson(CONFIG_PATH, raw); }
  if (name) writeSettings(target, { ...target.settings(), name });
  writeAgentsMd(target);
  return plan;
}

// ------------------------------------------------------------ sweep

/** What is left behind: orphan `pp-<slug>-t-NNNN` worktrees, merged branches of resolved threads, old done items. */
export function sweepPlan(project) {
  const plan = [];
  const all = threads.list(project);
  const openCwds = new Set(all.filter(threads.isOpen).map((t) => t.cwd));
  for (const repo of project.settings().repos.filter((r) => !r.machine)) {
    const r = sh(["git", "-C", repo.path, "worktree", "list", "--porcelain"]);
    if (!r.ok) continue;
    for (const block of r.stdout.split("\n\n")) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (path && threads.isOwnBranch(project.slug, branch) && !openCwds.has(path)) {
        plan.push({ what: `remove worktree ${path} (${branch})`, run: () => sh(["git", "-C", repo.path, "worktree", "remove", "--", path]) });
      }
    }
  }
  for (const t of all.filter((t) => t.status === "resolved" && t.branch && t.repo && !t.machine && t.pr_state === "MERGED")) {
    const tip = sh(["git", "-C", t.repo, "rev-parse", "--verify", "-q", `refs/heads/${t.branch}`]);
    if (!tip.ok || tip.stdout.trim() !== t.pr_summary?.head_oid) continue;
    if (isDir(t.cwd)) continue; // its worktree is still there; the worktree step goes first
    plan.push({ what: `delete merged branch ${t.branch} (${t.id})`, run: () => sh(["git", "-C", t.repo, "branch", "-D", "--", t.branch]) });
  }
  plan.push({ what: "delete handled inbox items older than 30 days", run: () => { inbox.pruneDone(project, 30); return { ok: true }; } });
  return plan;
}

// ------------------------------------------------------------ doctor

/** Problems per project and with the setup; `fix` repairs what is safe to repair. */
export async function doctor(root, fix) {
  const out = [];
  const config = loadConfig();
  for (const [name, p] of Object.entries(config.profiles)) if (!p.provider) out.push(`config.json: profile \`${name}\` has no provider`);
  try { await client(); } catch (e) { out.push(`the local Paseo daemon does not answer (${e.message}); \`paseo start\` starts it`); }
  for (const [name, m] of Object.entries(config.machines)) {
    if (!m.url) out.push(`config.json: machine \`${name}\` has no url`);
    else { try { await client(m.url); } catch (e) { out.push(`machine \`${name}\` (${m.url}) does not answer: ${e.message}`); } }
  }
  if (!ticker.runningPid(root)) {
    out.push("the ticker is not running");
    if (fix) { ticker.start(root); out.push("  fixed: ticker started"); }
  }
  for (const slug of listSlugs(root)) {
    const p = new Project(root, slug);
    const { error } = p.readLenient();
    if (error) out.push(`${slug}: ${error}`);
    for (const sub of SUBDIRS) if (!isDir(p.path(sub))) {
      out.push(`${slug}: ${sub}/ is missing`);
      if (fix) { mkdirSync(p.path(sub), { recursive: true }); out.push(`  fixed: ${sub}/ created`); }
    }
    if (!isFile(p.path("TASKS.md"))) {
      out.push(`${slug}: TASKS.md is missing`);
      if (fix) { writeFileSync(p.path("TASKS.md"), TASKS_TEMPLATE); out.push("  fixed: TASKS.md created"); }
    }
    if (!readText(p.path("AGENTS.md")).includes(`(\`${slug}\`)`) || !existsSync(p.path("CLAUDE.md")) || !existsSync(p.path(".claude", "settings.json"))) {
      out.push(`${slug}: AGENTS.md, CLAUDE.md or .claude/settings.json is missing or stale`);
      if (fix) { writeAgentsMd(p); out.push("  fixed: AGENTS.md, CLAUDE.md and .claude/settings.json written"); }
    }
    for (const t of threads.list(p).filter((t) => t.status === "starting" && secondsSince(t.created) > threads.STARTING_TIMEOUT_SECS)) {
      out.push(`${slug}: ${t.id} has been starting for over 5 minutes; \`thread restart ${slug} ${t.id}\``);
    }
  }
  return out;
}

/** Every thread waiting on the user or ready for review, across projects. */
export async function overview(root) {
  const lines = [];
  for (const slug of listSlugs(root)) {
    const p = new Project(root, slug);
    if (p.status === "archived") continue;
    let rows;
    try { rows = threads.sortRows((await threads.rows(p)).filter((r) => threads.isOpen(r.t))); }
    catch (e) { lines.push(`${slug}: live state unavailable: ${e.message}`); continue; }
    const counts = {};
    for (const r of rows) counts[r.group] = (counts[r.group] ?? 0) + 1;
    const summary = Object.entries(counts).map(([g, n]) => `${n} ${threads.GROUPS[g].label.toLowerCase()}`).join(", ") || "no open threads";
    lines.push(`${slug} (${p.status}) — ${p.displayName()}: ${summary}; ${inbox.unhandled(p).length} inbox item(s)`);
    for (const r of rows.filter((r) => ["waiting-on-you", "ready-for-review", "landing"].includes(r.group))) lines.push(`  ${threads.rowLine(r)}`);
  }
  return lines;
}
