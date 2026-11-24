// Loopback-only fake Paseo daemon on the SDK's wire protocol.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(fileURLToPath(import.meta.resolve("@getpaseo/client")));
const ws = require("ws");
const agents = new Map(), archiveAttempts = new Set(), at = new Date().toISOString();
let creates = 0;
const workspaces = [], pageInfo = { nextCursor: null, prevCursor: null, hasMore: false };
const projectFile = process.env.FAKE_PASEO_PROJECT;
const project = () => ({ projectId: "prj_repo", projectRootPath: readFileSync(projectFile, "utf8"), projectDisplayName: "Repo", projectKind: "git" });
const mode = process.env.FAKE_DAEMON_MODE, wss = new ws.WebSocketServer({ port: 0, host: "127.0.0.1" });
wss.on("listening", () => console.log(wss.address().port));
wss.on("connection", (s) => s.on("message", (raw) => {
  const m = JSON.parse(String(raw)), send = (message) => s.send(JSON.stringify({ type: "session", message }));
  if (m.type === "ping") return s.send(JSON.stringify({ type: "pong" }));
  if (m.type === "hello") return send({ type: "status", payload: { status: "server_info", serverId: "fake", features: { workspaceMultiplicity: true } } });
  const r = m.message ?? {}, requestId = r.requestId;
  if (r.type === "get_daemon_config_request" && mode === "reject") return send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "permission denied" } });
  if (r.type === "get_daemon_config_request") return send({ type: "get_daemon_config_response", payload: { requestId, config: mode === "malformed" ? "nope" : { mcp: { injectIntoAgents: false }, autoArchiveAfterMerge: mode === "on" } } });
  if (r.type === "archive_workspace_request") {
    const first = mode === "archive-retry" && !archiveAttempts.has(r.workspaceId);
    archiveAttempts.add(r.workspaceId);
    return send({ type: "archive_workspace_response", payload: { requestId, workspaceId: r.workspaceId, archivedAt: first ? null : new Date().toISOString(), error: first ? "workspace archive refused" : null } });
  }
  if (r.type === "project.list.request") return send({ type: "project.list.response", payload: { requestId, projects: projectFile ? [project()] : [] } });
  if (r.type === "fetch_workspaces_request") return send({ type: "fetch_workspaces_response", payload: { requestId, entries: workspaces, pageInfo } });
  if (r.type === "workspace.create.request") {
    if (r.source.kind !== "directory" || r.source.projectId !== project().projectId) throw new Error("expected a directory workspace under the source repo");
    const workspace = { ...project(), id: "wks_ovnfs_" + workspaces.length, workspaceDirectory: r.source.path,
      workspaceKind: "checkout", name: r.title, status: "done", activityAt: null, gitRuntime: null, githubRuntime: null };
    workspaces.push(workspace);
    return send({ type: "workspace.create.response", payload: { requestId, workspace, setupTerminalId: null, error: null } });
  }
  if (r.type === "fetch_agents_request") return send({ type: "fetch_agents_response", payload: { requestId, entries: [], pageInfo } });
  if (r.type === "create_agent_request") {
    if (++creates === 1 && mode === "create-retry") return send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "agent create refused" } });
    const id = "agent-" + (agents.size + 1), { branch, newBranch, base } = r.worktree ?? {};
    const cwd = r.worktree ? join(dirname(r.config.cwd), newBranch || "wt") : r.config.cwd;
    if (r.worktree) execFileSync("git", ["-C", r.config.cwd, "worktree", "add", "-q", ...(newBranch ? ["-b", newBranch, cwd, base || "HEAD"] : [cwd, branch])], { stdio: "ignore" });
    else if (r.workspaceId && !workspaces.some((w) => w.id === r.workspaceId && w.workspaceDirectory === cwd)) throw new Error("agent placed outside the directory workspace");
    const agent = { id, provider: "claude", cwd, workspaceId: r.workspaceId ?? "wks_restarted", model: null, createdAt: at, updatedAt: at, lastUserMessageAt: null, status: "idle",
      capabilities: { supportsStreaming: false, supportsSessionPersistence: false, supportsDynamicModes: false, supportsMcpServers: false, supportsReasoningStream: false, supportsToolInvocations: false },
      currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null, title: null, labels: r.labels ?? {} };
    agents.set(id, agent);
    if (process.env.FAKE_PASEO_AGENTS) appendFileSync(process.env.FAKE_PASEO_AGENTS, JSON.stringify({ id, cwd }) + "\n");
    return send({ type: "status", payload: { status: "agent_created", requestId, agentId: id, agent } });
  }
  if (r.type === "fetch_agent_request") return send({ type: "fetch_agent_response", payload: { requestId, agent: agents.get(r.agentId) ?? null, error: null } });
  if (r.type === "archive_agent_request" && (agents.has(r.agentId) || r.agentId === "agent-for-resolve")) {
    const first = mode === "archive-retry" && !archiveAttempts.has(r.agentId);
    archiveAttempts.add(r.agentId);
    if (first) return send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "agent archive refused" } });
    const archivedAt = new Date().toISOString(), agent = agents.get(r.agentId);
    if (agent) agent.archivedAt = archivedAt;
    return send({ type: "agent_archived", payload: { requestId, agentId: r.agentId, archivedAt } });
  }
  if (r.type === "send_agent_message_request") return send({ type: "send_agent_message_response", payload: { requestId, agentId: r.agentId, accepted: true, error: null } });
  if (requestId) send({ type: "rpc_error", payload: { requestId, requestType: r.type, error: "not faked" } });
}));
