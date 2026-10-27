import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createGreeting } from "./server/greeting";
import { greetingRpc } from "./shared/greeting";
import { boardAction, boardSection, inboxDone, listInbox, listTasks, threadAction, threadDetail } from "./server/tasks";
import { boardActionRpc, boardSectionRpc, inboxDoneRpc, inboxListRpc, tasksRpc, threadActionRpc, threadDetailRpc } from "./shared/tasks";

export default function contribute(server: PluginServerContext) {
  server.handle(greetingRpc, createGreeting);
  server.handle(tasksRpc, listTasks);
  server.handle(threadDetailRpc, threadDetail);
  server.handle(threadActionRpc, threadAction);
  server.handle(inboxListRpc, listInbox);
  server.handle(inboxDoneRpc, inboxDone);
  server.handle(boardSectionRpc, boardSection);
  server.handle(boardActionRpc, boardAction);
  return () => {};
}
