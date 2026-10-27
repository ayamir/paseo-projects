// TASKS.md: `## List` headings, `- [ ] title (owner) · t-0007` lines, notes
// indented under a task. The coordinator is the only writer; this only reads.
import { validateProfileName } from "./config.mjs";

export const isMachineName = (n) => Boolean(n) && !n.startsWith("-") && /^[A-Za-z0-9._-]+$/.test(n);
const profileOk = (n) => { try { validateProfileName(n); return true; } catch { return false; } };

/** { type: unassigned | me | agent{profile, machine} | person{text} }. */
export function parseOwner(text) {
  const t = String(text).trim();
  if (t === "" || t === "agent") return { type: "unassigned" };
  if (t === "me") return { type: "me" };
  const at = t.indexOf("@");
  const [profile, machine] = at >= 0 ? [t.slice(0, at), t.slice(at + 1)] : [t, null];
  const ok = (profile === "" && machine !== null) || profileOk(profile);
  if (!ok || (machine !== null && !isMachineName(machine))) return { type: "person", text: t };
  return { type: "agent", profile: profile || null, machine };
}

export function ownerText(o) {
  if (o.type === "me") return "me";
  if (o.type === "person") return o.text;
  if (o.type === "agent") return !o.profile && !o.machine ? "default profile" : `${o.profile ?? ""}${o.machine ? `@${o.machine}` : ""}`;
  return "";
}

/** A name-shaped owner that is no profile here (`Priya`) is a person. */
export const isPerson = (o, isProfile) => o.type === "person" || (o.type === "agent" && o.profile && !o.machine && !isProfile(o.profile));

const isTaskLine = (l) => { const s = l.trimStart(); return s.startsWith("- [") && s[4] === "]"; };
const indent = (l) => l.length - l.trimStart().length;
const isThreadId = (s) => /^t-[A-Za-z0-9-]+$/.test(s);

// The description lines under the task line at `i`; blank lines count only between them.
function body(lines, i) {
  const base = indent(lines[i]);
  let end = i + 1, last = i;
  while (end < lines.length) {
    const l = lines[end];
    if (!l.trim()) { end++; continue; }
    if (indent(l) <= base || isTaskLine(l) || l.startsWith("#")) break;
    last = end++;
  }
  const taken = lines.slice(i + 1, last + 1);
  const cut = Math.min(...taken.filter((l) => l.trim()).map(indent), Infinity);
  return { text: taken.map((l) => (l.trim() ? l.slice(cut === Infinity ? 0 : cut).trimEnd() : "")), next: last + 1 };
}

function splitLine(rest) {
  let thread = null;
  const dot = rest.lastIndexOf("·");
  if (dot >= 0 && isThreadId(rest.slice(dot + 1).trim())) {
    thread = rest.slice(dot + 1).trim();
    rest = rest.slice(0, dot).trimEnd();
  }
  const open = rest.lastIndexOf("(");
  if (open < 0 || !rest.endsWith(")")) return { title: rest, owner: { type: "unassigned" }, thread };
  const title = rest.slice(0, open).trim();
  const inner = rest.slice(open + 1, -1).trim();
  const arrow = inner.indexOf("→");
  if (arrow >= 0 && isThreadId(inner.slice(arrow + 1).trim())) {
    thread ??= inner.slice(arrow + 1).trim();
    const who = inner.slice(0, arrow).trim();
    return { title, owner: who === "agent" ? { type: "agent", profile: null, machine: null } : parseOwner(who), thread };
  }
  return { title, owner: parseOwner(inner), thread };
}

export function parse(text) {
  const lines = text.split("\n");
  const tasks = [];
  let list = "";
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.startsWith("## ")) { list = line.slice(3).trim(); i++; continue; }
    if (!isTaskLine(line)) { i++; continue; }
    const { title, owner, thread } = splitLine(line.trimStart().slice(5).trim());
    const { text: desc, next } = body(lines, i);
    tasks.push({ list, title, owner, thread, description: desc.join("\n") });
    i = next;
  }
  return tasks;
}

/** TASKS.md for `context`: each task's notes folded into one `notes:` line. */
export function compact(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    out.push(lines[i]);
    if (!isTaskLine(lines[i])) { i++; continue; }
    const { text: desc, next } = body(lines, i);
    const filled = desc.filter((l) => l.trim());
    if (filled.length) {
      const first = filled[0].trim();
      const preview = [...first].length > 60 ? [...first].slice(0, 60).join("") + "…" : first;
      const more = filled.length > 1 ? ` (+${filled.length - 1} more lines in TASKS.md)` : "";
      out.push(`${" ".repeat(indent(lines[i]))}  notes: ${preview}${more}`);
    }
    i = next;
  }
  return out.join("\n");
}

export function find(text, title) {
  const wanted = title.trim().toLowerCase();
  const t = parse(text).find((x) => x.title.toLowerCase() === wanted);
  if (!t) throw new Error(`TASKS.md has no task titled "${title}"; --from-task takes the title exactly as it is written there`);
  return t;
}

/** The thread's task: the coordinator's text, then the task's notes. */
export function delegated(text, title, task) {
  const found = find(text, title);
  if (!found.description.trim()) return task;
  return `${task.trimEnd()}\n\n## Notes from the task list\n\n${found.description.trim()}\n`;
}

/** The profile and machine a delegated task starts with; a contradicting flag is refused. */
export function launchFor(task, profile, machine) {
  const { title, owner } = task;
  if (owner.type === "unassigned") return { profile, machine };
  if (owner.type === "me") throw new Error(`"${title}" is the user's own task (me); change its owner in TASKS.md before delegating it`);
  if (owner.type === "person") throw new Error(`"${title}" belongs to ${owner.text}, a person; people's tasks are never delegated. Change its owner in TASKS.md first if the user asks`);
  if (profile && owner.profile && profile !== owner.profile) throw new Error(`"${title}" is assigned to profile \`${owner.profile}\`, not \`${profile}\`; change its owner in TASKS.md first, or leave out --profile`);
  if (machine && machine !== owner.machine) throw new Error(`"${title}" is assigned to ${owner.machine ? `machine \`${owner.machine}\`` : "this machine"}, not \`${machine}\`; change its owner in TASKS.md first, or leave out --machine`);
  return { profile: profile || owner.profile, machine: owner.machine };
}
