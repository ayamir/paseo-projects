// Project lifecycle: pause, archive, delete, rename; sweep and doctor.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { client, autoArchiveAfterMerge, readText, readJson, writeJson, isFile, isDir, secondsSince } from "./lib.mjs";
import { CONFIG_PATH, canonical, loadConfig, moveApprovals } from "./config.mjs";
import { Project, SUBDIRS, TASKS_TEMPLATE, writeAgentsMd, writeSettings, listSlugs } from "./project.mjs";
import * as threads from "./threads.mjs";
import * as inbox from "./inbox.mjs";
import * as ticker from "./ticker.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
export { withLifecycleLock };

/** Every agent Paseo has for a project (thread and coordinator), not archived. */
async function liveAgents(project) {
  const c = await client();
  const r = await c.agents.list({ filter: { labels: { project: project.slug } } });
  return r.entries.map((e) => e.agent).filter((a) => !a.archivedAt && a.status !== "closed" && ["thread", "coordinator"].includes(a.labels?.role));
}

/** Throws unless every one was archived, so a caller changes nothing on disk while agents still run. */
async function archiveAgents(project) {
  const c = await client();
  const agents = await liveAgents(project);
  const failed = [];
  for (const a of agents) await c.agents.ref(a.id).archive().catch((e) => failed.push(`${a.id}: ${e.message}`));
  if (failed.length) throw new Error(`${failed.length} of ${agents.length} agent(s) were not archived (${failed.join("; ")})`);
  return agents.length;
}

export function pause(project) { project.setState({ status: "paused" }); }
export function resume(project) { project.setState({ status: "active" }); }

/** Archived only once its agents are: a daemon that does not answer leaves the project as it was. */
export async function archive(project) {
  const n = await archiveAgents(project);
  project.setState({ status: "archived" });
  return n;
}
export function unarchive(project) { project.setState({ status: "active" }); }

/** Moves the folder to <root>/.trash/<slug>-<stamp>. */
export async function remove(project, force) {
  return withLifecycleLock(project, () => removeLocked(project, force));
}

async function removeLocked(project, force) {
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
export async function rename(project, newSlug, options) {
  return withLifecycleLock(project, () => renameLocked(project, newSlug, options));
}

async function renameLocked(project, newSlug, { name, dryRun = false } = {}) {
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

/** Unclaimed and historical resources appear in discovery, not in the sweep plan. */
export function sweepPlan(project) {
  const plan = threads.list(project).filter(threads.pendingDisposal).map((t) => ({
    what: `check managed resources of ${t.id}`,
    run: async () => ({ ok: true, out: (await threads.cleanupAgain(project, t.id, { scheduled: true })).join("; ") }),
  }));
  plan.push({ what: "delete handled inbox items older than 30 days", run: () => { inbox.pruneDone(project, 30); return { ok: true }; } });
  return plan;
}

// ------------------------------------------------------------ doctor

/** Problems per project and with the setup; `fix` repairs what is safe to repair. */
export async function doctor(root, fix) {
  const out = [];
  const config = loadConfig();
  for (const [name, p] of Object.entries(config.profiles)) if (!p.provider) out.push(`config.json: profile \`${name}\` has no provider`);
  // A second remover of thread worktrees, one that skips pp's checks and keeps; the setting is host-wide.
  // Not read is unknown, said as such: it may still be on.
  const autoArchives = async (url, where) => {
    await client(url);
    const a = await autoArchiveAfterMerge(url);
    if (a.on) out.push(`${where}: Paseo's daemon.autoArchiveAfterMerge is on; it removes a merged thread's worktree with --force whatever pp keeps, often before pp copies its library home. \`paseo daemon config set daemon.autoArchiveAfterMerge false\`, then \`paseo daemon reload\`, leaves the removal to pp (it also stops it for workspaces pp does not manage)`);
    else if (a.on === null) out.push(`${where}: Paseo's daemon.autoArchiveAfterMerge could not be read (${a.why}); whether it removes merged thread worktrees that pp keeps is unknown`);
  };
  try { await autoArchives(undefined, "the local Paseo daemon"); } catch (e) { out.push(`the local Paseo daemon does not answer (${e.message}); \`paseo start\` starts it`); }
  for (const [name, m] of Object.entries(config.machines)) {
    if (!m.url) out.push(`config.json: machine \`${name}\` has no url`);
    else { try { await autoArchives(m.url, `machine \`${name}\``); } catch (e) { out.push(`machine \`${name}\` (${m.url}) does not answer: ${e.message}`); } }
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
