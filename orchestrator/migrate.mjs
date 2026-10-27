// `migrate-herdr`: copies herdr-projects projects into this root; thread records
// `.toml` become `.json` beside them. When this root is the herdr root itself, the
// projects are converted where they are: the herdr files paseo-projects would
// overwrite are moved to `.state/herdr/`, and nothing else of herdr's changes.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { sh, readText, readJson, writeJson, parseToml, isFile } from "./lib.mjs";
import { CONFIG_PATH, canonical } from "./config.mjs";
import { Project, SUBDIRS, writeAgentsMd } from "./project.mjs";
import { latestSession } from "./threads.mjs";

const HERDR_CONFIG = join(homedir(), ".config", "herdr-projects", "config.toml");
const SAFETY = ["yolo", "start_threads", "routine_commands", "thread_profiles", "coordinator_profiles"];
// Left behind: herdr's pane records and ticker state mean nothing to Paseo.
const EXCLUDE = [".state/lock", ".state/coordinator.json", ".state/coordinators.json", ".state/ticker.json", ".claude/settings.local.json"];
// Converting in place also sets these aside: paseo-projects writes its own.
const SET_ASIDE = [...EXCLUDE, "AGENTS.md", "CLAUDE.md"];

/** A herdr thread record as a paseo-projects one; paths under the old folder move with it. */
export function convertThread(h, oldDir, newDir) {
  const move = (p) => (p && (p === oldDir || p.startsWith(`${oldDir}/`)) ? newDir + p.slice(oldDir.length) : p ?? "");
  const pick = (k, d = "") => h[k] ?? d;
  return {
    id: h.id, title: pick("title"), status: pick("status", "open"), error: pick("error"), kind: pick("kind", "worktree"),
    repo: pick("repo"), origin: pick("origin"), branch: pick("branch"), base: pick("base"), machine: pick("machine"),
    cwd: move(h.cwd || h.worktree_path), thread_dir: move(h.thread_dir), agent_id: "", workspace_id: "",
    profile: pick("profile"), provider: "", created: pick("created"), updated: pick("updated"),
    last_state: "", last_state_change: pick("last_state_change"), last_group: pick("last_group"),
    report_hash: pick("report_hash"), last_report_change: pick("last_report_change"),
    last_review_item_hash: pick("last_review_item_hash"), acked_report_hash: pick("acked_report_hash"),
    pr: pick("pr"), pr_state: pick("pr_state"), pr_review: pick("pr_review"),
    resolved_reason: pick("resolved_reason"), kept_worktree: Boolean(h.kept_worktree),
    session: null, // herdr kept none; migrate() asks the live pane, else its Claude folder
  };
}

/** The Claude session a live herdr pane runs, if the pane is still the record's (herdr reuses pane ids). */
export function sessionOfPane(pane, cwd) {
  if (!pane || pane.agent !== "claude" || (pane.cwd !== cwd && pane.foreground_cwd !== cwd)) return null;
  return pane.agent_session?.value || null;
}
function livePaneSession(paneId, cwd) {
  if (!paneId) return null;
  const r = sh(["herdr", "pane", "get", paneId], undefined, undefined, { timeout: 5000 });
  try { return r.ok ? sessionOfPane(JSON.parse(r.stdout).result.pane, cwd) : null; } catch { return null; }
}

/** herdr profiles `{ agent, model }` → `{ provider: "agent/model" }`; Claude ones in auto mode. */
export function convertProfile(p) {
  const out = { provider: p.model ? `${p.agent}/${p.model}` : p.agent };
  if (p.agent === "claude") out.mode = "auto";
  if (p.description) out.description = p.description;
  return out;
}

/** Profiles and safety tables into config.json; what the user already set there wins. */
function mergeConfig(herdr, moves) {
  const raw = readJson(CONFIG_PATH, {}) ?? {};
  const added = [];
  raw.profiles ??= {};
  for (const [name, p] of Object.entries(herdr.profiles ?? {})) {
    if (raw.profiles[name] || !p.agent) continue;
    raw.profiles[name] = convertProfile(p);
    added.push(`profile ${name}`);
  }
  raw.safety ??= {};
  for (const [from, to] of [["default", "default"], ...moves]) {
    const t = herdr.safety?.[from];
    if (!t) continue;
    const table = (raw.safety[to] ??= {});
    for (const k of SAFETY) if (k in t && !(k in table)) { table[k] = t[k]; added.push(`safety ${to === "default" ? "default" : "table"} ${k}`); }
    if (!Object.keys(table).length) delete raw.safety[to];
  }
  writeJson(CONFIG_PATH, raw);
  return added;
}

export function migrate(herdrRoot, root, { dryRun = false } = {}) {
  const slugs = readdirSync(herdrRoot).filter((n) => isFile(join(herdrRoot, n, "PROJECT.md")));
  const log = [];
  const moves = [];
  const inPlace = canonical(herdrRoot) === canonical(root);
  for (const slug of slugs) {
    const from = join(herdrRoot, slug), to = join(root, slug);
    const aside = join(to, ".state", "herdr");
    if (inPlace ? existsSync(aside) : existsSync(to)) { log.push(`${slug}: skipped, ${inPlace ? "already converted" : `${to} already exists`}`); continue; }
    const records = readdirSync(join(from, "threads")).filter((n) => /^t-\d{4,}\.toml$/.test(n));
    log.push(`${slug}: ${inPlace ? `convert ${to} in place` : `copy ${from} → ${to}`}, ${records.length} thread record(s)`);
    if (dryRun) continue;
    // Read before they are set aside. The live pane knows its session; the records may be stale.
    const coords = [...(readJson(join(from, ".state", "coordinators.json"), []) ?? []), readJson(join(from, ".state", "coordinator.json"), null)].filter((c) => c?.agent === "claude");
    const coordSession = coords.map((c) => livePaneSession(c.pane_id, from)).find(Boolean) ?? coords.find((c) => c.agent_session)?.agent_session;
    if (inPlace) {
      mkdirSync(aside, { recursive: true });
      for (const e of SET_ASIDE) if (existsSync(join(to, e))) renameSync(join(to, e), join(aside, basename(e)));
    } else {
      mkdirSync(root, { recursive: true });
      const r = sh(["rsync", "-a", ...EXCLUDE.flatMap((e) => ["--exclude", `/${e}`]), `${from}/`, `${to}/`], undefined, undefined, { timeout: 30 * 60_000 });
      if (!r.ok) throw new Error(`rsync ${slug}: ${r.out}`);
    }
    for (const sub of SUBDIRS) mkdirSync(join(to, sub), { recursive: true });
    for (const n of records) {
      const h = parseToml(readText(join(to, "threads", n)), n);
      const t = convertThread(h, from, to);
      // The live pane's session, else the newest in the pane's own Claude folder (a checkout shares its folder: no guess).
      const cwd = h.cwd || h.worktree_path || "";
      const id = h.agent !== "claude" ? null : (h.status !== "resolved" && livePaneSession(h.pane_id, cwd)) || (t.kind !== "checkout" ? latestSession(cwd) : null);
      if (id) t.session = { provider: "claude", id };
      writeJson(join(to, "threads", n.replace(/\.toml$/, ".json")), t);
    }
    writeAgentsMd(new Project(root, slug));
    // herdr's pane record is left behind, but its session is what `open` picks up.
    if (coordSession) writeJson(join(to, ".state", "coordinator.json"), { session: { provider: "claude", id: coordSession, from: "herdr" } });
    moves.push([canonical(from), canonical(to)]);
    const open = records.length && readdirSync(join(to, "threads")).filter((n) => n.endsWith(".json") && readJson(join(to, "threads", n))?.status !== "resolved");
    if (open?.length) log.push(`${slug}: open threads ${open.map((n) => n.slice(0, -5)).join(", ")} have no Paseo agent; stop them in herdr, then \`thread restart\` each: it picks up the pane's Claude session`);
  }
  if (!dryRun && moves.length && isFile(HERDR_CONFIG)) {
    const added = mergeConfig(parseToml(readText(HERDR_CONFIG), "herdr config.toml"), moves);
    log.push(`config.json: ${added.length ? added.join(", ") : "nothing new"}`);
  }
  return log;
}
