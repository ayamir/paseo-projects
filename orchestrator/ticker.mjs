// The ticker: one resident process for the whole root. Every 15 s it copies
// reports home, turns state changes into inbox items, follows pull requests,
// resolves merged and idle threads, runs routines and nudges coordinators.
import { spawn } from "node:child_process";
import { openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, sh, now, secondsSince, writeJson, readText, closeClients } from "./lib.mjs";
import { loadConfig, loadSafety, isApproved } from "./config.mjs";
import { Project, listSlugs } from "./project.mjs";
import * as threads from "./threads.mjs";
import * as inbox from "./inbox.mjs";
import * as pr from "./pr.mjs";
import * as routines from "./routines.mjs";
import * as coordinator from "./coordinator.mjs";

export const TICK_SECS = 15;
export const PR_POLL_SECS = 120;
export const GH_OUTAGE_SECS = 600;
export const MERGED_GRACE_SECS = 600;
export const DONE_KEEP_DAYS = 30;

const pidPath = (root) => join(root, ".ticker.pid");
export const logPath = (root) => join(root, ".ticker.log");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function runningPid(root) {
  const pid = Number(readText(pidPath(root)).trim());
  return pid && alive(pid) ? pid : null;
}

/** `ticker start`: a detached `ticker run`, logging to <root>/.ticker.log. */
export function start(root) {
  const pid = runningPid(root);
  if (pid) return { pid, started: false };
  const fd = openSync(logPath(root), "a");
  const child = spawn(process.execPath, [join(REPO, "bin", "pp.mjs"), "--root", root, "ticker", "run"], { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  return { pid: child.pid, started: true };
}

export function stop(root) {
  const pid = runningPid(root);
  if (!pid) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

/** `ticker run`: the loop. One per root, held by a pid file. */
export async function run(root) {
  const other = runningPid(root);
  if (other && other !== process.pid) throw new Error(`a ticker already runs for ${root} (pid ${other})`);
  writeFileSync(pidPath(root), String(process.pid));
  let stopping = false;
  const quit = () => { stopping = true; };
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
  const started = now();
  console.log(`${now()} ticker ${process.pid} up for ${root}`);
  try {
    while (!stopping) {
      for (const slug of listSlugs(root)) {
        if (stopping) break;
        try { await tick(new Project(root, slug), started); }
        catch (e) { console.error(`${now()} ${slug}: ${e.stack ?? e.message}`); }
      }
      // shortcut: plain polling; subscribe to agent updates if 15 s ever feels slow.
      for (let i = 0; i < TICK_SECS * 4 && !stopping; i++) await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    if (Number(readText(pidPath(root)).trim()) === process.pid) rmSync(pidPath(root), { force: true });
    await closeClients();
    console.log(`${now()} ticker ${process.pid} down`);
  }
}

// ------------------------------------------------------------ one pass

function loadState(project, started) {
  const s = coordinator.readTickerState(project);
  return { started_at: started, routines: {}, broken: [], outages: {}, ...s };
}

/** Desktop notification, unless the project is muted. */
/** A desktop notification; `sound` only when the user is needed, as in herdr-projects. */
export function notify(project, settings, subtitle, text, sound = false) {
  if (settings.mute) return;
  const title = `${project.displayName(settings)} · ${subtitle}`;
  if (process.platform === "darwin") sh(["osascript", "-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}${sound ? ' sound name "Glass"' : ""}`], undefined, undefined, { timeout: 5000 });
  else sh(["notify-send", title, text], undefined, undefined, { timeout: 5000 });
}

const EVENT = {
  blocked: "blocked on a permission", "agent gone": "agent gone", "agent error": "agent error", "start failed": "start failed",
  "start timed out": "start timed out", "waiting for you": "waiting on you",
};

export async function tick(project, started = now()) {
  if (project.status === "archived") return;
  const { settings, error } = project.readLenient();
  const state = loadState(project, started);
  const at = Date.now();
  const pollPrs = secondsSince(state.last_pr_poll, at) >= PR_POLL_SECS || !state.last_pr_poll;

  // PROJECT.md errors, once per file content.
  if (error && !state.broken.includes(`PROJECT.md:${project.readLenient().hash}`)) {
    inbox.write(project, "routine", "project-md", "config error", `PROJECT.md does not parse: ${error}`);
    state.broken.push(`PROJECT.md:${project.readLenient().hash}`);
  }

  // Live state, copies, transitions.
  const open = threads.list(project).filter(threads.isOpen);
  const agents = await threads.agentsOf(project, new Set(["", ...open.map((t) => t.machine || "")]));
  for (const m of new Set([...Object.keys(state.outages), ...(agents.unreachable ?? [])])) {
    const down = (agents.unreachable ?? []).includes(m);
    if (down && !state.outages[m]) { inbox.write(project, "outage", m, "unreachable", `the Paseo daemon on ${m} does not answer: ${agents.error}`); state.outages[m] = now(); }
    if (!down && state.outages[m]) { inbox.write(project, "outage", m, "working again", `the Paseo daemon on ${m} answers again`); delete state.outages[m]; }
  }
  const unreachable = new Set((agents.unreachable ?? []).map((m) => (m === "local" ? "" : m)));
  for (let t of open) {
    if (unreachable.has(t.machine || "")) continue;
    if (!t.machine || pollPrs) {
      const c = threads.copyHome(project, t);
      if (c.hash && c.hash !== t.report_hash) t = threads.update(project, t.id, (r) => { r.report_hash = c.hash; r.last_report_change = now(); });
    }
    const p = agents.get(t.agent_id)?.persistence;
    // Kept so `thread restart` can pick the conversation up after the agent is gone.
    if (p?.sessionId && p.sessionId !== t.session?.id) t = threads.update(project, t.id, (r) => { r.session = { provider: p.provider, id: p.sessionId }; });
    const progress = threads.progressOf(project, t.id);
    let live = threads.liveOf(t, agents.get(t.agent_id), progress, at);
    if ((live.state ?? "") !== t.last_state) {
      t = threads.update(project, t.id, (r) => { r.last_state = live.state ?? ""; r.last_state_change = now(); });
      live = threads.liveOf(t, agents.get(t.agent_id), progress, at);
    }
    const g = threads.group(t, live, at);
    if (g.group !== t.last_group) {
      if (["waiting-on-you", "landing", "idle"].includes(g.group)) {
        const event = g.group === "landing" ? "landing" : g.group === "idle" ? "idle" : EVENT[g.note] ?? "waiting on you";
        const how = g.note === "blocked" ? `; \`thread permissions ${project.slug} ${t.id}\` shows the request, \`thread allow|deny\` answers it`
          : ["agent gone", "agent error", "start failed", "start timed out"].includes(g.note) ? `; \`thread restart ${project.slug} ${t.id}\` starts a new agent` : "";
        inbox.write(project, "thread-state", t.id, event, `${t.id} "${t.title}" is now ${threads.GROUPS[g.group].label} (${g.note})${how}`);
        if (g.group === "waiting-on-you") notify(project, settings, t.id, `${t.title}: ${g.note}`, true);
      }
      t = threads.update(project, t.id, (r) => { r.last_group = g.group; });
    }
    if (["ready-for-review", "landing"].includes(g.group) && t.report_hash && t.last_review_item_hash !== t.report_hash) {
      inbox.write(project, "thread-state", t.id, "new report", `${t.id} "${t.title}" has a new report: threads/${t.id}.md`);
      notify(project, settings, t.id, `${t.title}: new report`);
      t = threads.update(project, t.id, (r) => { r.last_review_item_hash = r.report_hash; });
    }
  }

  if (pollPrs) {
    await followPrs(project, settings, state, agents, at);
    await autoResolve(project, settings, state, agents, at);
    inbox.pruneDone(project, DONE_KEEP_DAYS);
    state.last_pr_poll = now();
  }
  if (project.status === "active" && !error) await runRoutines(project, state);
  if (project.status === "active") await nudge(project, settings, state);
  project.lock(() => writeJson(coordinator.tickerStatePath(project), state));
}

// ------------------------------------------------------------ pull requests

async function followPrs(project, settings, state, agents, at) {
  const own = new Map();
  const ownOf = (origin) => { const h = pr.hostOf(origin); if (!own.has(h)) own.set(h, pr.ownLogin(origin)); return own.get(h); };
  let ghFailed = false;
  for (let t of threads.list(project).filter(threads.isOpen)) {
    t = threads.refreshBranch(project, t);
    const report = readText(threads.homeReportPath(project, t.id));
    const line = pr.prLine(report);
    if (line.note && t.pr_note_hash !== t.report_hash) {
      inbox.write(project, "pr", t.id, "bad PR line", `${t.id} "${t.title}": ${line.note}`);
      t = threads.update(project, t.id, (r) => { r.pr_note_hash = r.report_hash; });
    }
    let url = line.url ?? (t.pr || null);
    try {
      if (!url && t.kind === "worktree" && t.branch) url = pr.findByBranch(t.origin, t.branch);
      if (!url) continue;
      const reduced = pr.reduce(pr.view(url, t.origin), t.branch, t.origin);
      if (reduced.ignored) {
        if (t.pr_ignored_url !== url) {
          inbox.write(project, "pr", t.id, "PR ignored", `${t.id} "${t.title}": ${url} is not followed: ${reduced.ignored}`);
          threads.update(project, t.id, (r) => { r.pr_ignored_url = url; });
        }
        continue;
      }
      const s = pr.withChecks(reduced.summary, settings.pr_checks);
      const old = t.pr === url ? t.pr_summary ?? null : null;
      if (JSON.stringify(old) !== JSON.stringify(s)) {
        const events = pr.prEvents(old, s, ownOf(t.origin));
        t = threads.update(project, t.id, (r) => {
          Object.assign(r, { pr: url, pr_state: s.state, pr_review: s.review_decision, pr_summary: s });
          if (s.state === "MERGED" && !r.merged_seen_at) r.merged_seen_at = now();
        });
        const phrase = pr.prEventPhrase(events, s);
        inbox.write(project, "pr", t.id, phrase, `${t.id} "${t.title}" ${url}: ${pr.describeChange(old, s)}`);
        if (events.length) notify(project, settings, t.id, `${t.title}: ${phrase}`);
        await prRoutines(project, t, url, events, s);
      }
      if (s.state === "MERGED") await resolveMerged(project, t, url, s, agents, at);
    } catch (e) {
      ghFailed = true;
      console.error(`${now()} ${project.slug} ${t.id}: ${e.message}`);
    }
  }
  if (ghFailed) {
    state.gh_fail_since ??= now();
    if (!state.gh_outage_reported && secondsSince(state.gh_fail_since, at) >= GH_OUTAGE_SECS) {
      inbox.write(project, "outage", "gh", "gh failing", "`gh` has failed for 10 minutes; pull requests are not followed until it works again");
      state.gh_outage_reported = true;
    }
  } else {
    if (state.gh_outage_reported) inbox.write(project, "outage", "gh", "gh working again", "`gh` works again; pull requests are followed");
    delete state.gh_fail_since;
    delete state.gh_outage_reported;
  }
}

async function prRoutines(project, t, url, events, s) {
  if (!events.length || project.status !== "active") return;
  for (const r of routines.loadAll(project).routines) {
    if (!r.enabled || !r.trigger.pr) continue;
    const fired = events.filter((e) => r.trigger.pr.includes(e));
    if (!fired.length) continue;
    try {
      await threads.prompt(project, t.id, pr.prRoutinePrompt(r.name, r.prompt, url, fired, s));
      inbox.write(project, "routine", r.name, "sent to thread", `routine \`${r.name}\` prompted ${t.id} (${fired.join(", ")})`);
    } catch (e) {
      inbox.write(project, "routine", r.name, "not sent", `routine \`${r.name}\` could not prompt ${t.id}: ${e.message}`);
    }
  }
}

/** A merged thread resolves once it is done with it: idle, and finished or quiet for a while. */
async function resolveMerged(project, t, url, s, agents, at) {
  const live = threads.liveOf(t, agents.get(t.agent_id), threads.progressOf(project, t.id), at);
  const g = threads.group(t, live, at).group;
  if (g === "working" || g === "waiting-on-you") return;
  const p = live.progress;
  const finished = p ? p.percent === 100 : (t.last_report_change && t.last_report_change > t.merged_seen_at) || secondsSince(t.merged_seen_at, at) >= MERGED_GRACE_SECS;
  if (!finished) return;
  const refs = pr.reportRefs(readText(threads.homeReportPath(project, t.id)), t.origin, url);
  for (const [repo, numbers] of refs) {
    const openOwn = pr.openOwnNumbers(repo, pr.hostOf(t.origin));
    const still = [...numbers].filter((n) => openOwn.has(n));
    if (still.length) return; // another of its pull requests is still open
  }
  await threads.resolve(project, t.id, { reason: "merged", mergedHead: s.head_oid, why: `was resolved: ${url} merged` });
}

async function autoResolve(project, settings, state, agents, at) {
  const days = settings.auto_resolve_days;
  if (!days) return;
  for (const t of threads.list(project).filter(threads.isOpen)) {
    if (t.status !== "open") continue;
    const live = threads.liveOf(t, agents.get(t.agent_id), threads.progressOf(project, t.id), at);
    if (threads.group(t, live, at).group !== "idle") continue;
    const since = [t.last_state_change, t.last_report_change, state.started_at].filter(Boolean).sort().pop();
    if (secondsSince(since, at) < days * 86400) continue;
    try { await threads.resolve(project, t.id, { reason: "auto", why: `was resolved after ${days} idle day(s)` }); }
    catch (e) { console.error(`${now()} ${project.slug} ${t.id}: ${e.message}`); }
  }
}

// ------------------------------------------------------------ routines and nudges

async function runRoutines(project, state) {
  const { routines: list, broken } = routines.loadAll(project);
  for (const b of broken) {
    if (state.broken.includes(b.hash)) continue;
    inbox.write(project, "routine", b.file.replace(/^routines\/|\.md$/g, ""), "config error", `${b.file} does not parse: ${b.error}`);
    state.broken.push(b.hash);
  }
  const safety = loadSafety(loadConfig(), project.dir);
  let coord;
  for (const r of list) {
    if (!r.enabled || !r.trigger.schedule) continue;
    const st = (state.routines[r.name] ??= {});
    if (!st.last_run) { st.last_run = now(); continue; }
    if (!routines.isDue(r.trigger.schedule, new Date(st.last_run))) continue;
    st.last_run = now();
    coord ??= await coordinator.live(project).catch(() => null);
    if (!coord) { st.no_coordinator = (st.no_coordinator ?? 0) + 1; continue; }
    st.no_coordinator = 0;
    if (r.command) {
      if (!safety.routine_commands || !isApproved(project.dir, r.name, r.command)) {
        const h = `${safety.routine_commands}:${r.command}`;
        if (st.approval_for !== h) {
          const why = safety.routine_commands ? "its command is not approved" : "routine commands are off for this project";
          inbox.write(project, "routine-approval", r.name, "needs approval", `routine \`${r.name}\` did not run: ${why}. The user runs \`pp routine approve ${project.slug} ${r.name}\` (and \`pp safety set ${project.slug} routine_commands on\`).`);
          st.approval_for = h;
        }
        continue;
      }
      const out = routines.runCommand(project, r);
      if (out.outputHash === st.output_hash) continue;
      st.output_hash = out.outputHash;
      st.item_id = inbox.write(project, "routine", r.name, "output", `routine \`${r.name}\` ran (${out.exit})`, `${r.prompt}\n\n${out.block}`);
      continue;
    }
    if (st.item_id && inbox.unhandled(project).some((i) => i.id === st.item_id)) { st.skipped = (st.skipped ?? 0) + 1; continue; }
    st.item_id = inbox.write(project, "routine", r.name, "due", `routine \`${r.name}\` is due`, r.prompt);
    st.skipped = 0;
  }
}

/** One `[pp inbox]` line per new set of unseen items, to an idle coordinator. */
async function nudge(project, settings, state) {
  const seen = inbox.seen(project);
  const fresh = inbox.unhandled(project).filter((i) => !seen.has(i.id));
  if (!fresh.length) { delete state.nudge_hash; return; }
  const h = inbox.hashIds(fresh.map((i) => i.id));
  if (h === state.nudge_hash) return;
  if (!settings.nudge) { state.nudge_hash = h; return; }
  const a = await coordinator.live(project).catch(() => null);
  if (!a) { state.nudge_hash = h; return; }
  if (!coordinator.nudgeable(a)) return; // busy: the next pass tries again
  await coordinator.prompt(project, `${inbox.nudgeText(fresh)}\n(run \`context\` to read them)`);
  state.nudge_hash = h;
}

