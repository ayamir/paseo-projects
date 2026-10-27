#!/usr/bin/env node
// paseo-projects: projects with a coordinator agent and thread agents on Paseo.
// `pp help` lists the commands.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeClients, readText, writeAtomic, splitFront, requirePerson, ask } from "../orchestrator/lib.mjs";
import { loadConfig, loadSafety, setSafety, parseSafetyValue, SAFETY_KEYS, canonical, listedNames, getProfile, profileSummary, storeApproval, isApproved, yoloKnown, validateProfileName, ROLES, allowed, agentConfig, editConfig, changeProfile, BUILTINS, kindOf } from "../orchestrator/config.mjs";
import { Project, rootOf, create, listSlugs, parseRepoArg, applySetting, writeSettings, writeAgentsMd, SET_KEYS, prefix } from "../orchestrator/project.mjs";
import * as threads from "../orchestrator/threads.mjs";
import * as coordinator from "../orchestrator/coordinator.mjs";
import * as inbox from "../orchestrator/inbox.mjs";
import * as tasks from "../orchestrator/tasks.mjs";
import * as routines from "../orchestrator/routines.mjs";
import * as ticker from "../orchestrator/ticker.mjs";
import * as lifecycle from "../orchestrator/lifecycle.mjs";
import { migrate } from "../orchestrator/migrate.mjs";
import { boardData, editArgs } from "../orchestrator/board.mjs";

const HELP = `pp [--root DIR] <command>

Projects
  new <slug> [--name N] [--goal G] [--repo PATH[@MACHINE]]... [--thread-profile P] [--coordinator-profile P]
  list [--all] [--json]          overview
  open <slug> [--profile P] [--fresh]
                                 find the coordinator, else pick up its last session (--fresh: a new one); starts the ticker
  context <slug> [--peek]        the coordinator's digest
  skill                          the coordinator's instructions
  set <slug> <key> <value>       ${Object.keys(SET_KEYS).join(", ")}
  assignable <slug> [--check OWNER]
  inbox list|done <slug> [<item-id>... | --all]
  coordinator prompt <slug> (--text T | --text-file F|-)
  pause|resume|archive|unarchive <slug>
  delete <slug> [--force]
  rename <slug> <new-slug> [--name N] [--dry-run]
  sweep <slug> [--dry-run] [--yes]
  doctor [--fix]
  migrate-herdr [HERDR_ROOT] [--dry-run]   copy herdr-projects projects here (default ~/.herdr-projects)
  board tasks|routines|settings|memory     what the board plugin shows, as JSON
  board edit <json>              a settings edit from the board, as the command it maps to

Threads
  thread start <slug> --title T (--task T | --task-file F|- | --from-task TITLE) [--repo PATH] [--kind worktree|tab|checkout] [--machine M] [--profile P] [--base REF]
  thread list <slug> [--all] [--json]
  thread show <slug> <id> [--json]
  thread prompt <slug> <id> (--text T | --text-file F|-)
  thread next <slug> <id> [--line N | --add LINE]
  thread stop|ack <slug> <id>
  thread restart <slug> <id> [--profile P] [--fresh | --session ID|latest]
                                 picks up the old session unless --fresh; latest: the newest Claude session in its folder
  thread resolve <slug> <id> [--reopen] [--keep-worktree] [--skip-copy] [--force]
  thread permissions <slug> <id>
  thread allow <slug> <id> [--request R] [--action A] [--answers JSON]
  thread deny <slug> <id> [--request R] [--action A] [--message M]
  report [--thread SLUG/ID] (--percent N | --unknown) [--activity A]

The user's alone (refused unless run at a terminal)
  routine list <slug> | routine approve <slug> <name> | routine toggle <slug> <name> [on|off]
  safety show <slug> | safety set (<slug>|--global) <key> <value...> | safety yolo (<slug>|--global) on|off
  profile list [--project SLUG]  profiles; with --project, which ones it allows and its defaults
  profile resolve [NAME] [--project SLUG]
                                 a profile and the agent config it launches with, as JSON
  profile add|edit <name> [--provider KIND/MODEL] [--mode M] [--thinking T] [--yolo-mode M] [--description D]
                                 edit: given fields only; an empty value clears one
  profile remove <name>          refused while a default, allow-list or project names it
  profile allow (<slug>|--global) thread|coordinator [NAME...]
                                 no names: any profile; "default": inherit
  profile default thread|coordinator <name>
                                 what new projects start with
  ticker run|start|stop|status
`;

const VALUE_FLAGS = new Set(["root", "name", "goal", "repo", "thread-profile", "coordinator-profile", "profile", "check", "text", "text-file", "title", "task", "task-file", "from-task", "kind", "machine", "base", "line", "add", "request", "action", "answers", "message", "thread", "percent", "activity", "session", "project", "provider", "mode", "thinking", "yolo-mode", "description"]);

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "-") { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (VALUE_FLAGS.has(k)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === "repo" && flags.repos) flags.repos.push(v); else if (k === "repo") flags.repos = [v];
      flags[k] = v;
    } else flags[k] = true;
  }
  return { pos, flags };
}

const readInput = (path) => (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8"));
const textOf = (f, what = "text") => {
  if (f[what] !== undefined) return String(f[what]);
  if (f[`${what}-file`] !== undefined) return readInput(f[`${what}-file`]);
  throw new Error(`give --${what} or --${what}-file`);
};
const need = (v, usage) => { if (v === undefined || v === "") throw new Error(`usage: pp ${usage}`); return v; };

async function main() {
  const { pos, flags: f } = parse(process.argv.slice(2));
  const root = rootOf({ root: f.root });
  const proj = (slug, usage) => Project.open(root, need(slug, usage));
  const [cmd, a1, a2, a3] = pos;

  switch (cmd) {
    case undefined: case "help": case "-h": process.stdout.write(HELP); return;

    case "new": {
      const p = create(root, need(a1, "new <slug>"), {
        name: f.name ?? "", goal: f.goal ?? "", repos: (f.repos ?? []).map(parseRepoArg),
        threadProfile: f["thread-profile"], coordinatorProfile: f["coordinator-profile"],
      });
      console.log(`created ${p.dir}\n\`${prefix(root)} open ${p.slug}\` starts its coordinator`);
      return;
    }
    case "list": {
      const out = [];
      for (const slug of listSlugs(root)) {
        const p = new Project(root, slug);
        if (p.status === "archived" && !f.all) continue;
        const open = threads.list(p).filter(threads.isOpen).length;
        out.push({ slug, status: p.status, name: p.displayName(), open_threads: open, inbox: inbox.unhandled(p).length });
      }
      if (f.json) { console.log(JSON.stringify(out, null, 2)); return; }
      if (!out.length) console.log(`no projects in ${root}; \`pp new <slug>\` makes one`);
      for (const o of out) console.log(`${o.slug}\t${o.status}\t${o.open_threads} open thread(s)\t${o.inbox} inbox item(s)\t${o.name}`);
      return;
    }
    case "overview": (await lifecycle.overview(root)).forEach((l) => console.log(l)); return;
    case "open": {
      const p = proj(a1, "open <slug>");
      const { agent, created, resumed } = await coordinator.open(p, f.profile, { fresh: Boolean(f.fresh) });
      const t = ticker.start(root);
      console.log(`${created ? (resumed ? "picked up" : "started") : "found"} the coordinator of ${p.slug}: agent ${agent.id}${t.started ? `; ticker started (pid ${t.pid})` : ""}`);
      console.log(`open it in the Paseo app, or \`paseo attach ${agent.id}\` / \`paseo send ${agent.id} "..."\``);
      return;
    }
    case "context": process.stdout.write(await coordinator.context(proj(a1, "context <slug>"), { peek: Boolean(f.peek) })); return;
    case "skill": process.stdout.write(coordinator.skillText()); return;
    case "set": {
      const p = proj(a1, "set <slug> <key> <value>");
      const value = pos.slice(3).join(" ");
      need(a2, "set <slug> <key> <value>");
      const s = applySetting(p.settings(), a2, value);
      if (a2.endsWith("_profile") && value) { validateProfileName(value); if (!getProfile(loadConfig(), value)) throw new Error(`no profile \`${value}\``); }
      writeSettings(p, s);
      if (a2 === "name") writeAgentsMd(p);
      console.log(`${p.slug}: ${a2} set`);
      return;
    }
    case "assignable": {
      const p = proj(a1, "assignable <slug>");
      if (f.check !== undefined) { console.log(coordinator.checkOwner(p, f.check)); return; }
      console.log(coordinator.assignableLine(coordinator.assignable(p)));
      return;
    }
    case "inbox": {
      const p = proj(a2, "inbox list|done <slug>");
      if (a1 === "list") { for (const i of inbox.unhandled(p)) console.log(`${i.id}\t[${i.kind}] ${i.summary}`); return; }
      if (a1 === "done") { console.log(`${inbox.done(p, pos.slice(3), Boolean(f.all))} item(s) done`); return; }
      throw new Error("usage: pp inbox list|done <slug>");
    }
    case "coordinator": {
      if (a1 !== "prompt") throw new Error("usage: pp coordinator prompt <slug> --text T");
      await coordinator.prompt(proj(a2, "coordinator prompt <slug>"), textOf(f));
      console.log("sent");
      return;
    }
    case "pause": case "resume": case "unarchive": {
      const p = proj(a1, `${cmd} <slug>`);
      lifecycle[cmd](p);
      console.log(`${p.slug} is ${p.status}`);
      return;
    }
    case "archive": { const p = proj(a1, "archive <slug>"); const n = await lifecycle.archive(p); console.log(`${p.slug} archived; ${n} agent(s) archived`); return; }
    case "delete": { const target = await lifecycle.remove(proj(a1, "delete <slug>"), Boolean(f.force)); console.log(`moved to ${target}`); return; }
    case "rename": {
      const plan = await lifecycle.rename(proj(a1, "rename <slug> <new-slug>"), need(a2, "rename <slug> <new-slug>"), { name: f.name, dryRun: Boolean(f["dry-run"]) });
      console.log((f["dry-run"] ? "would " : "done: ") + plan.join("; "));
      return;
    }
    case "sweep": {
      const plan = lifecycle.sweepPlan(proj(a1, "sweep <slug>"));
      plan.forEach((s) => console.log(`- ${s.what}`));
      if (f["dry-run"]) return;
      if (!f.yes) { requirePerson("sweep without --yes"); if (ask("do these? [y/N] ").toLowerCase() !== "y") return; }
      for (const s of plan) { const r = s.run(); console.log(`${r.ok ? "done" : `failed: ${r.out}`}: ${s.what}`); }
      return;
    }
    case "migrate-herdr": {
      const from = a1 ?? join(homedir(), ".herdr-projects");
      migrate(from, root, { dryRun: Boolean(f["dry-run"]) }).forEach((l) => console.log(l));
      return;
    }
    case "doctor": { const out = await lifecycle.doctor(root, Boolean(f.fix)); console.log(out.length ? out.join("\n") : "all good"); return; }
    case "thread": return threadCommand(pos.slice(1), f, root, proj);
    case "report": {
      const ref = f.thread ?? process.env.PP_THREAD;
      if (!ref || !ref.includes("/")) throw new Error("give --thread SLUG/ID (or run inside a thread, which sets PP_THREAD)");
      const [slug, id] = ref.split("/");
      const percent = f.unknown ? null : Number(need(f.percent, "report --percent N"));
      if (percent !== null && !(percent >= 0 && percent <= 100)) throw new Error("--percent is 0 to 100");
      threads.reportProgress(Project.open(root, slug), id, percent, f.activity);
      console.log(`recorded: ${percent ?? "?"}% · ${f.activity ?? ""}`);
      return;
    }
    case "ticker": {
      if (a1 === "run") return ticker.run(root);
      if (a1 === "start") { const t = ticker.start(root); console.log(t.started ? `ticker started (pid ${t.pid}); log ${ticker.logPath(root)}` : `ticker already runs (pid ${t.pid})`); return; }
      if (a1 === "stop") { console.log(ticker.stop(root) ? "ticker stopped" : "no ticker runs"); return; }
      if (a1 === "status") { const pid = ticker.runningPid(root); console.log(pid ? `ticker runs (pid ${pid}); log ${ticker.logPath(root)}` : "no ticker runs"); return; }
      throw new Error("usage: pp ticker run|start|stop|status");
    }
    case "routine": return routineCommand(a1, a2, a3, pos[4], root, proj);
    case "safety": return safetyCommand(pos.slice(1), f, root, proj);
    case "profile": return profileCommand(pos.slice(1), f, root, proj);
    case "board": {
      if (a1 !== "edit") { console.log(JSON.stringify(boardData(root, a1))); return; }
      // Runs the edit as its own command line, so the dialog and the error name that command.
      process.argv = [...process.argv.slice(0, 2), "--root", root, ...editArgs(JSON.parse(need(a2, "board edit <json>")))];
      return main();
    }
    default: throw new Error(`unknown command \`${cmd}\`; \`pp help\` lists them`);
  }
}

async function threadCommand([sub, slug, id], f, root, proj) {
  const usage = `thread ${sub} <slug> <id>`;
  const p = proj(slug, `thread ${sub} <slug>`);
  const tid = () => need(id, usage);
  switch (sub) {
    case "start": {
      let task = f["from-task"] === undefined ? textOf(f, "task") : (f.task !== undefined || f["task-file"] !== undefined ? textOf(f, "task") : "");
      let profile = f.profile, machine = f.machine;
      if (f["from-task"] !== undefined) {
        const text = readText(p.path("TASKS.md"));
        const found = tasks.find(text, f["from-task"]);
        ({ profile, machine } = tasks.launchFor(found, profile, machine));
        task = tasks.delegated(text, f["from-task"], task || found.title);
      }
      const { thread: t, warnings } = await threads.start(p, { title: f.title, task, repo: f.repo, kind: f.kind, machine: machine ?? undefined, profile: profile ?? undefined, base: f.base });
      warnings.forEach((w) => console.log(`warning: ${w}`));
      console.log(`started ${t.id} (${t.kind}${t.branch ? `, branch ${t.branch}` : ""}, profile ${t.profile}) agent ${t.agent_id}`);
      return;
    }
    case "list": {
      const rows = threads.sortRows((await threads.rows(p)).filter((r) => f.all || threads.isOpen(r.t)));
      if (f.json) { console.log(JSON.stringify(rows.map((r) => threads.rowJson(p, r)), null, 2)); return; }
      for (const r of rows) console.log(`${r.t.id}\t${threads.GROUPS[r.group].label}\t${r.note}\t${r.t.title}`);
      return;
    }
    case "show": {
      const r = (await threads.rows(p)).find((x) => x.t.id === tid());
      if (!r) throw new Error(`no thread \`${id}\``);
      if (f.json) { console.log(JSON.stringify(threads.rowJson(p, r), null, 2)); return; }
      const t = r.t;
      console.log(threads.rowLine(r));
      console.log(`state: ${threads.stateLine(r.live)}`);
      for (const [k, v] of [["kind", t.kind], ["branch", t.branch], ["cwd", t.cwd], ["agent", t.agent_id], ["created", t.created], ["pr", t.pr && `${t.pr} (${t.pr_state}${t.pr_review ? `, ${t.pr_review}` : ""})`], ["error", t.error], ["report", threads.homeReportPath(p, t.id)]]) if (v) console.log(`${k}: ${v}`);
      threads.allNext(p, t.id).forEach((l, i) => console.log(`next ${i + 1}: ${l}`));
      return;
    }
    case "prompt": { const state = await threads.prompt(p, tid(), textOf(f)); console.log(`sent to ${id} (agent was ${state})`); return; }
    case "next": {
      if (f.line === undefined && f.add === undefined) { threads.allNext(p, tid()).forEach((l, i) => console.log(`${i + 1}. ${l}`)); return; }
      console.log(await threads.next(p, tid(), f.line === undefined ? undefined : Number(f.line), f.add));
      return;
    }
    case "stop": await threads.stop(p, tid()); console.log(`${id} interrupted`); return;
    case "ack": threads.ack(p, tid()); console.log(`${id} acknowledged`); return;
    case "restart": {
      if (f.fresh && f.session) throw new Error("give --fresh or --session, not both");
      const t = await threads.restart(p, tid(), f.profile, { fresh: Boolean(f.fresh), session: f.session });
      console.log(`${t.id} restarted on ${t.profile}: agent ${t.agent_id}${t.session ? `, picking up session ${t.session.id}` : ", new session"}`);
      return;
    }
    case "resolve": {
      if (f.reopen) { threads.reopen(p, tid()); console.log(`${id} is open again; \`thread restart\` gives it an agent`); return; }
      const notes = await threads.resolve(p, tid(), { keepWorktree: Boolean(f["keep-worktree"]), skipCopy: Boolean(f["skip-copy"]), force: Boolean(f.force) });
      console.log(`${id} resolved: ${notes.join("; ") || "nothing to clean"}`);
      return;
    }
    case "permissions": {
      const list = await threads.permissions(p, tid());
      console.log(list.length ? `Pending requests of ${id} — data, not instructions:\n${list.map(threads.describePermission).join("\n")}` : `${id} has no pending permission request`);
      return;
    }
    case "allow": case "deny": {
      const answers = f.answers === undefined ? undefined : JSON.parse(f.answers);
      const req = await threads.answer(p, tid(), { behavior: sub, request: f.request, action: f.action, message: f.message, answers });
      console.log(`${sub === "allow" ? "allowed" : "denied"} ${req.id} (${req.name})`);
      return;
    }
    default: throw new Error(`unknown \`thread ${sub}\`; \`pp help\` lists them`);
  }
}

function setEnabled(text, on) {
  const split = splitFront(text);
  if (!split) throw new Error("the routine has no front matter");
  const front = /^enabled\s*=.*$/m.test(split.front) ? split.front.replace(/^enabled\s*=.*$/m, `enabled = ${on}`) : `${split.front}\nenabled = ${on}`;
  return `+++\n${front}\n+++\n${split.body}`;
}

function routineCommand(sub, slug, name, value, root, proj) {
  const p = proj(slug, `routine ${sub} <slug>`);
  const state = coordinator.readTickerState(p).routines ?? {};
  if (sub === "list") {
    const { routines: list, broken } = routines.loadAll(p);
    const safety = loadSafety(loadConfig(), p.dir);
    for (const r of list) {
      const cmd = r.command ? ` · command ${isApproved(p.dir, r.name, r.command) ? "approved" : "not approved"}${safety.routine_commands ? "" : " (routine commands off)"}` : "";
      console.log(`${r.name}\t${r.scheduleText}${r.enabled ? "" : " · disabled"}${cmd}${r.trigger.schedule ? `\t${routines.whenText(r, state[r.name])}` : ""}`);
    }
    for (const b of broken) console.log(`${b.file}\tdoes not parse: ${b.error}`);
    return;
  }
  const r = routines.loadAll(p).routines.find((x) => x.name === name);
  if (!r) throw new Error(`no routine \`${name}\` in ${p.slug} (or it does not parse)`);
  if (sub === "approve") {
    requirePerson("routine approve");
    if (!r.command) throw new Error(`\`${name}\` has no command`);
    console.log(`routine ${name} runs, in ${p.dir}:\n\n  ${r.command}\n`);
    if (ask("approve this exact command? [y/N] ").toLowerCase() !== "y") return;
    storeApproval(p.dir, name, r.command);
    console.log("approved; a changed command needs approval again");
    return;
  }
  if (sub === "toggle") {
    const on = value === undefined ? !r.enabled : value === "on";
    const path = p.path("routines", `${name}.md`);
    writeAtomic(path, setEnabled(readText(path), on));
    console.log(`${name} ${on ? "enabled" : "disabled"}`);
    return;
  }
  throw new Error("usage: pp routine list|approve|toggle <slug> [name]");
}

function profileCommand([sub = "list", ...rest], f, root, proj) {
  const config = loadConfig();
  const exists = (n) => { validateProfileName(n); if (!getProfile(config, n)) throw new Error(`no profile \`${n}\`; profiles: ${listedNames(config).join(", ")}`); return n; };
  const roleOf = (r) => { if (!ROLES[r]) throw new Error(`\`${r}\` is not a role: thread, coordinator`); return ROLES[r]; };
  const p = f.project ? proj(f.project, `profile ${sub} --project <slug>`) : null;
  if (sub === "list") {
    for (const n of listedNames(config)) console.log(`${n}\t${profileSummary(getProfile(config, n))}${config.profiles[n] ? "" : " (built-in)"}`);
    if (!p) return;
    const safety = loadSafety(config, p.dir);
    for (const [role, r] of Object.entries(ROLES)) console.log(`${role}s in ${p.slug}: ${allowed(safety, role)?.join(", ") ?? "any"} (${safety.source[r.list]}); default ${p.settings()[r.def] || "none"}`);
    return;
  }
  if (sub === "resolve") {
    const name = exists(rest[0] ?? (p?.settings().thread_profile || config.defaults.thread_profile || "claude"));
    const prof = getProfile(config, name);
    console.log(JSON.stringify({ ...prof, agent: agentConfig(prof, p ? loadSafety(config, p.dir) : loadSafety(config, "")) }, null, 2));
    return;
  }
  requirePerson(`profile ${sub}`);
  if (sub === "add" || sub === "edit") {
    const name = need(rest[0], `profile ${sub} <name> --provider KIND/MODEL`);
    const fields = { provider: f.provider, mode: f.mode, thinking: f.thinking, yolo_mode: f["yolo-mode"], description: f.description };
    editConfig((raw) => changeProfile(raw, sub, name, fields));
    const prof = getProfile(loadConfig(), name);
    // shortcut: the kind is checked against the built-in list only; ask the daemon's providers list if custom providers appear.
    if (!BUILTINS.includes(kindOf(prof))) console.log(`warning: \`${kindOf(prof)}\` is not a provider pp knows (${BUILTINS.join(", ")})`);
    console.log(`${sub === "add" ? "added" : "changed"} ${name}: ${profileSummary(prof)}`);
    return;
  }
  if (sub === "remove") {
    const name = need(rest[0], "profile remove <name>");
    const users = listSlugs(root).filter((s) => { const st = new Project(root, s).readLenient().settings; return st.thread_profile === name || st.coordinator_profile === name; });
    if (users.length) throw new Error(`profile \`${name}\` is a default in ${users.join(", ")}; change it there first (pp set <slug> thread_profile|coordinator_profile)`);
    editConfig((raw) => changeProfile(raw, "remove", name));
    console.log(`removed ${name}; threads that ran on it need --profile to restart`);
    return;
  }
  if (sub === "allow") {
    const global = Boolean(f.global);
    const [role, ...names] = global ? rest : rest.slice(1);
    const r = roleOf(need(role, "profile allow (<slug>|--global) thread|coordinator [NAME...]"));
    const value = names.length === 1 && names[0] === "default" ? undefined : names.flatMap((n) => n.split(",")).filter(Boolean).map(exists);
    const table = global ? "default" : canonical(proj(rest[0], "profile allow <slug>").dir);
    setSafety(table, r.list, value);
    console.log(`${role}s in ${global ? "all projects" : rest[0]}: ${value === undefined ? "inherit" : value.join(", ") || "any profile"}`);
    return;
  }
  if (sub === "default") {
    const r = roleOf(need(rest[0], "profile default thread|coordinator <name>"));
    const name = exists(need(rest[1], "profile default thread|coordinator <name>"));
    editConfig((raw) => { (raw.defaults ??= {})[r.def] = name; });
    console.log(`new projects start ${rest[0]}s on ${name}; existing ones keep theirs (pp set <slug> ${r.def})`);
    return;
  }
  throw new Error("usage: pp profile list|resolve|add|edit|remove|allow|default");
}

function safetyCommand([sub, target, ...rest], f, root, proj) {
  const config = loadConfig();
  if (sub === "show") {
    const p = proj(target, "safety show <slug>");
    const s = loadSafety(config, p.dir);
    for (const k of Object.keys(SAFETY_KEYS)) console.log(`${k} = ${JSON.stringify(s[k])}\t(${s.source[k]})\t${SAFETY_KEYS[k]}`);
    return;
  }
  requirePerson(`safety ${sub}`);
  const global = Boolean(f.global);
  const words = global && target !== undefined ? [target, ...rest] : rest;
  const table = global ? "default" : canonical(proj(target, `safety ${sub} <slug>`).dir);
  if (sub === "yolo") {
    const on = parseSafetyValue("yolo", words);
    if (on) {
      const p = global ? null : proj(target, "safety yolo <slug>");
      const names = p ? [p.settings().thread_profile, p.settings().coordinator_profile].filter(Boolean) : Object.keys(config.profiles);
      for (const n of names) { const prof = getProfile(config, n); if (prof && !yoloKnown(prof)) console.log(`warning: profile \`${n}\` has no yolo_mode; its agents still ask`); }
    }
    setSafety(table, "yolo", on);
    console.log(`yolo ${on === undefined ? "reset" : on ? "on" : "off"} for ${global ? "all projects" : target}; running agents keep their mode until restarted`);
    return;
  }
  if (sub === "set") {
    const [key, ...vals] = words;
    setSafety(table, need(key, "safety set <slug> <key> <value>"), parseSafetyValue(key, vals));
    console.log(`${key} set for ${global ? "all projects" : target}`);
    return;
  }
  throw new Error("usage: pp safety show|set|yolo");
}

main().then(() => closeClients(), async (e) => {
  console.error(`error: ${e.message}`);
  await closeClients();
  process.exitCode = 1;
  // An open socket must not keep a finished command alive; exit only once piped stdout is flushed, or long output is cut.
}).finally(() => process.stdout.write("", () => process.exit()));
