// The command line's one definition: each line below is a usage line, and the options a command takes are read
// from it. `pp help`, the parser and the check for options a command does not take all come from this table.
// In a usage line, `--name` is an option; it takes a value when a placeholder word follows (`--title T`),
// otherwise it is a switch (`--force`).
import { SET_KEYS } from "./project.mjs";

const HEADER = "[--root DIR] <command>";

// [usage, what it does]; the note is for people and is never read for options.
const SECTIONS = [
  ["Projects", [
    ["new <slug> [--name N] [--goal G] [--repo PATH[@MACHINE]]... [--thread-profile P] [--coordinator-profile P]"],
    ["list [--all] [--json]", "overview"],
    ["overview", "every open thread that waits on you, across projects"],
    ["open <slug> [--profile P] [--fresh]", "find the coordinator, else pick up its last session (--fresh: a new one); starts the ticker"],
    ["context <slug> [--peek]", "the coordinator's digest"],
    ["skill", "the coordinator's instructions"],
    ["set <slug> <key> <value>", Object.keys(SET_KEYS).join(", ")],
    ["assignable <slug> [--check OWNER]"],
    ["inbox list <slug>"],
    ["inbox done <slug> [<item-id>... | --all]"],
    ["coordinator prompt <slug> (--text T | --text-file F|-)"],
    ["pause|resume|archive|unarchive <slug>"],
    ["delete <slug> [--force]"],
    ["rename <slug> <new-slug> [--name N] [--dry-run]"],
    ["sweep <slug> [--dry-run] [--yes]"],
    ["doctor [--fix]"],
    ["migrate-herdr [HERDR_ROOT] [--dry-run]", "copy herdr-projects projects here (default ~/.herdr-projects)"],
    ["board tasks|routines|settings|memory", "what the board plugin shows, as JSON"],
    ["board edit <json>", "a settings edit from the board, as the command it maps to"],
  ]],
  ["Threads", [
    ["thread start <slug> --title T (--task T | --task-file F|- | --from-task TITLE) [--repo PATH] [--kind worktree|tab|checkout] [--machine M] [--profile P] [--base REF]"],
    ["thread list <slug> [--all] [--json]"],
    ["thread show <slug> <id> [--json]"],
    ["thread prompt <slug> <id> (--text T | --text-file F|-)"],
    ["thread next <slug> <id> [--line N | --add LINE]"],
    ["thread stop|ack <slug> <id>"],
    ["thread restart <slug> <id> [--profile P] [--fresh | --session ID|latest]", "picks up the old session unless --fresh; latest: the newest Claude session in its folder"],
    ["thread resolve <slug> <id> [--reopen] [--keep-worktree] [--skip-copy] [--force]", "report and library home, then the cleanup (docs/cleanup.md); `thread cleanup --dry-run` previews the cleanup"],
    ["thread cleanup <slug> <id> [--dry-run]", "the same cleanup again for a resolved thread; --dry-run previews it for any thread"],
    ["thread permissions <slug> <id>"],
    ["thread allow <slug> <id> [--request R] [--action A] [--answers JSON]"],
    ["thread deny <slug> <id> [--request R] [--action A] [--message M]"],
    ["report [--thread SLUG/ID] (--percent N | --unknown) [--activity A]"],
  ]],
  ["The user's alone (refused unless run at a terminal)", [
    ["routine list <slug>"],
    ["routine approve <slug> <name>"],
    ["routine toggle <slug> <name> [on|off]"],
    ["safety show <slug>"],
    ["safety set (<slug>|--global) <key> <value...>"],
    ["safety yolo (<slug>|--global) on|off"],
    ["profile list [--project SLUG]", "profiles; with --project, which ones it allows and its defaults"],
    ["profile resolve [NAME] [--project SLUG]", "a profile and the agent config it launches with, as JSON"],
    ["profile add|edit <name> [--provider KIND/MODEL] [--mode M] [--thinking T] [--yolo-mode M] [--description D]", "edit: given fields only; an empty value clears one"],
    ["profile remove <name>", "refused while a default, allow-list or project names it"],
    ["profile allow (<slug>|--global) thread|coordinator [NAME...]", "no names: any profile; \"default\": inherit"],
    ["profile default thread|coordinator <name>", "what new projects start with"],
    ["ticker run|start|stop|status"],
  ]],
];

/** The command words (`thread resolve`, each a list of alternatives) and the options a usage line declares. */
function declare(use) {
  const head = [];
  for (const w of use.split(/\s+/)) {
    if (!/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(w)) break;
    head.push(w.split("|"));
  }
  return { head, flags: flagsOf(use) };
}
const flagsOf = (use) => Object.fromEntries([...use.matchAll(/--([a-z][a-z-]*)(\s+(?=[A-Za-z]))?/g)].map((m) => [m[1], Boolean(m[2])]));

export const ENTRIES = SECTIONS.flatMap(([, rows]) => rows).map(([use, note]) => ({ use, note, ...declare(use) }));
const GLOBAL = flagsOf(HEADER);

// An option's name means one thing in every command, so the parser can read `--name value` before it knows the command.
export const VALUE_FLAGS = new Set();
const seen = { ...GLOBAL };
for (const e of ENTRIES) {
  for (const [name, takes] of Object.entries(e.flags)) {
    if (name in seen && seen[name] !== takes) throw new Error(`--${name} takes a value in one usage line and not in another: \`${e.use}\``);
    seen[name] = takes;
  }
}
for (const [name, takes] of Object.entries(seen)) if (takes) VALUE_FLAGS.add(name);

export const HELP = `pp ${HEADER}\n` + SECTIONS.map(([title, rows]) => `\n${title}\n` + rows.map(([use, note]) => {
  if (!note) return `  ${use}\n`;
  return use.length <= 29 ? `  ${use.padEnd(31)}${note}\n` : `  ${use}\n${" ".repeat(33)}${note}\n`;
}).join("")).join("");

/** Splits the arguments into positionals and options. `given` lists every option as typed and `inlined` every switch typed as `--x=v`, both for `check`. */
export function parse(argv) {
  const pos = [], flags = {}, given = [], inlined = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "-") { pos.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    given.push(k);
    if (VALUE_FLAGS.has(k)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === "repo" && flags.repos) flags.repos.push(v); else if (k === "repo") flags.repos = [v];
      flags[k] = v;
    } else {
      if (inline !== undefined) inlined.push(k); // every occurrence, so `--force=false --force` is still refused
      flags[k] = inline ?? true;
    }
  }
  return { pos, flags, given, inlined };
}

const usageOf = (entries) => entries.map((e) => `  pp ${e.use}`).join("\n");

/**
 * Throws, before the command does anything, for a command that is not one, for an option the command does not
 * declare, and for a switch given a value (`--force=false` would otherwise read as on).
 */
export function check(pos, given, inlined) {
  const [cmd] = pos;
  let entry = null;
  if (cmd !== undefined && cmd !== "help" && cmd !== "-h") {
    const named = ENTRIES.filter((e) => e.head[0].includes(cmd));
    if (!named.length) throw new Error(`unknown command \`${cmd}\`; \`pp help\` lists them`);
    const hit = named.filter((e) => e.head.every((alts, i) => i === 0 || alts.includes(pos[i])));
    if (hit.length !== 1) throw new Error(`unknown or incomplete command \`pp ${pos.slice(0, 3).join(" ")}\`; usage:\n${usageOf(named)}`);
    entry = hit[0];
  }
  const takes = { ...GLOBAL, ...entry?.flags };
  const unknown = [...new Set(given.filter((k) => !(k in takes)))];
  if (unknown.length) throw new Error(`unknown option${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `--${k}`).join(", ")} for \`pp ${entry ? entry.head.map((a, i) => pos[i] ?? a[0]).join(" ") : "help"}\`; usage:\n${entry ? usageOf([entry]) : `  pp ${HEADER}`}`);
  if (inlined.length) throw new Error(`--${inlined[0]} takes no value`);
}
