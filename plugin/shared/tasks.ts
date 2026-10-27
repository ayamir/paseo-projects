import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Every thread of every project, with the group the ticker last saw.
export const tasksRpc = defineRpc({
  name: "paseo-projects.threads.list",
  input: z.object({}),
  output: z.object({
    root: z.string(),
    threads: z.array(
      z.object({
        project: z.string(),
        id: z.string(),
        title: z.string(),
        group: z.string(),
        profile: z.string(),
        branch: z.string().nullable(),
        pr: z.string().nullable(),
        prState: z.string().nullable(),
        updated: z.string(),
      }),
    ),
  }),
});

// One thread: its report home and the report's `## Next` lines.
export const threadDetailRpc = defineRpc({
  name: "paseo-projects.thread.detail",
  input: z.object({ project: z.string(), id: z.string() }),
  output: z.object({ report: z.string(), next: z.array(z.string()), cwd: z.string(), status: z.string() }),
});

// What the board's buttons do: each one is a `pp` command, so the board can do nothing the CLI cannot.
export const threadActionRpc = defineRpc({
  name: "paseo-projects.thread.action",
  input: z.object({
    project: z.string(),
    id: z.string(),
    action: z.enum(["ack", "restart", "resolve", "next"]),
    line: z.number().int().positive().optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// Unhandled inbox items of every project that is not archived, oldest first.
export const inboxListRpc = defineRpc({
  name: "paseo-projects.inbox.list",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({ project: z.string(), id: z.string(), kind: z.string(), subject: z.string(), summary: z.string(), created: z.string() }),
    ),
  }),
});

export const inboxDoneRpc = defineRpc({
  name: "paseo-projects.inbox.done",
  input: z.object({ project: z.string(), ids: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// The tasks, routines, settings and memory tabs: `pp board <section>`, as it prints it.
export const BOARD_SECTIONS = ["tasks", "routines", "settings", "memory"] as const;
export const boardSectionRpc = defineRpc({
  name: "paseo-projects.board.section",
  input: z.object({ section: z.enum(BOARD_SECTIONS) }),
  // shortcut: untyped; give each section its own schema if the board grows more code reading it.
  output: z.object({ data: z.any() }),
});

// Task buttons ask the coordinator (as HP's popup does); a routine toggles with `pp routine toggle`.
export const boardActionRpc = defineRpc({
  name: "paseo-projects.board.action",
  input: z.object({ project: z.string(), kind: z.enum(["task", "routine"]), action: z.enum(["delegate", "done", "drop", "toggle"]), target: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** A settings edit; the server runs it as `pp board edit`, which asks you in a dialog for the user's own settings. */
export const boardEditRpc = defineRpc({
  name: "paseo-projects.board.edit",
  input: z.object({
    scope: z.enum(["project", "safety", "profile", "default"]),
    target: z.string().max(80),
    key: z.string().max(40),
    value: z.string().max(2000),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
