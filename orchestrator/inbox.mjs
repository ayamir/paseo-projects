// Inbox items: events the ticker leaves for the coordinator, one file each.
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readText, readJson, writeJson, writeAtomic, splitFront, parseToml, tomlLine, now, sha256 } from "./lib.mjs";

const dir = (project) => project.path("inbox");

function parse(text) {
  const split = splitFront(text);
  if (!split) return null;
  try { return { ...parseToml(split.front, "inbox item"), body: split.body.replace(/^\n+|\n+$/g, "") }; } catch { return null; }
}

/** File-name-safe form of a subject (a thread id, routine name, machine label). */
export function safeSubject(subject) {
  const s = [...String(subject)].map((c) => (/[A-Za-z0-9-]/.test(c) ? c.toLowerCase() : "-")).slice(0, 40).join("").replace(/^-+|-+$/g, "");
  return s || "item";
}

/**
 * Writes one item: `<UTC stamp>-<n>-<kind>-<subject>`, `n` from a counter
 * under the project lock. `event` is a fixed phrase from this program (nudges
 * are built from it, never from the summary); `body` is for routine items.
 */
export function write(project, kind, subject, event, summary, body = "") {
  return project.lock(() => {
    const counter = project.path(".state", "inbox-counter.json");
    const n = (readJson(counter, 0) ?? 0) + 1;
    writeJson(counter, n);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    // The counter right after the stamp keeps ids in creation order within one second.
    const id = `${stamp}-${String(n).padStart(6, "0")}-${kind}-${safeSubject(subject)}`;
    const front = [
      tomlLine("id", id), tomlLine("kind", kind), tomlLine("subject", subject), tomlLine("created", now()),
      tomlLine("summary", String(summary).replace(/[\u0000-\u001f\u007f]/g, " ")), tomlLine("event", event),
    ].join("\n");
    writeAtomic(join(dir(project), `${id}.md`), `+++\n${front}\n+++\n${body ? `\n${body.trimEnd()}\n` : ""}`);
    return id;
  });
}

/** Unhandled items, oldest first (ids start with a UTC stamp). */
export function unhandled(project) {
  let names = [];
  try { names = readdirSync(dir(project)).filter((n) => n.endsWith(".md")); } catch {}
  return names.map((n) => parse(readText(join(dir(project), n)))).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
}

export const seen = (project) => new Set(readJson(project.path(".state", "inbox-seen.json"), []) ?? []);

/** Records that `context` showed these items, so each is nudged once. */
export function markSeen(project, ids) {
  if (!ids.length) return;
  project.lock(() => {
    const live = new Set(unhandled(project).map((i) => i.id));
    const all = [...new Set([...seen(project), ...ids])].filter((id) => live.has(id));
    writeJson(project.path(".state", "inbox-seen.json"), all.sort());
  });
}

function validateId(id) {
  if (!id || id.startsWith(".") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`\`${id}\` is not an inbox item id`);
}

/** Moves items to inbox/done/. Returns how many moved. */
export function done(project, ids, all = false) {
  const list = all ? unhandled(project).map((i) => i.id) : ids;
  list.forEach(validateId);
  return project.lock(() => {
    let moved = 0;
    for (const id of list) {
      try { renameSync(join(dir(project), `${id}.md`), join(dir(project), "done", `${id}.md`)); moved++; }
      catch { console.error(`no unhandled item \`${id}\``); }
    }
    return moved;
  });
}

/** Deletes handled items older than `days`. */
export function pruneDone(project, days) {
  const d = join(dir(project), "done");
  let names = [];
  try { names = readdirSync(d); } catch { return; }
  for (const n of names) {
    try { if (Date.now() - statSync(join(d, n)).mtimeMs > days * 86_400_000) rmSync(join(d, n)); } catch {}
  }
}

const NUDGE_SUBJECTS = 5;

/**
 * The nudge line, e.g. `[pp inbox] t-0040 PR merged, new report; t-0043
 * blocked on a permission`. Built from kinds, safe subjects and fixed event
 * phrases only, newest first; summaries may quote GitHub and are never used.
 */
export function nudgeText(items) {
  const ordered = [...items].sort((a, b) => b.id.localeCompare(a.id));
  const parts = [];
  for (const item of ordered) {
    const subject = safeSubject(item.subject);
    const who = ["routine", "routine-approval"].includes(item.kind) ? `routine ${subject}`
      : item.kind === "outage" && subject !== "gh" ? `machine ${subject}`
      : ["session", "space"].includes(item.kind) ? "" : subject;
    const what = item.event || item.kind.replace(/-/g, " ");
    const part = parts.find((p) => p.who === who);
    if (!part) parts.push({ who, events: [what] });
    else if (!part.events.includes(what)) part.events.push(what);
  }
  const named = parts.slice(0, NUDGE_SUBJECTS).map((p) => `${p.who} ${p.events.join(", ")}`.trim());
  if (parts.length > NUDGE_SUBJECTS) named.push(`${parts.length - NUDGE_SUBJECTS} more`);
  return `[pp inbox] ${named.join("; ")}`;
}

export const hashIds = (ids) => sha256([...ids].sort().join("\n"));
