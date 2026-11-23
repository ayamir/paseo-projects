// v0.8.0 admin protocol, without the CLI's daemon auto-start. Isolated child for synchronous callers.
import { createConnection } from "node:net";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const MAX = 16 << 20;
const [state, mount, op, raw, timeout] = process.argv.slice(2);
const socket = join(state, "admin.sock");
const client = createConnection(socket);
const frames = (async function* () {
  let buf = Buffer.alloc(0);
  for await (const chunk of client) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const end = 4 + buf.readUInt32LE();
      if (end > 4 + MAX) throw new Error("oversized admin frame");
      if (buf.length < end) break;
      const frame = JSON.parse(buf.subarray(4, end));
      buf = buf.subarray(end);
      yield frame;
    }
  }
})();
async function exchange(msg) {
  const data = Buffer.from(JSON.stringify(msg));
  if (data.length > MAX) throw new Error("oversized admin request");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  client.write(Buffer.concat([size, data]));
  const { value, done } = await frames.next();
  if (done) throw new Error("admin connection closed with no reply");
  if (msg.id !== undefined) {
    if (value?.id !== msg.id) throw new Error("unmatched admin reply");
    if (value.error) throw new Error(`${value.error.code}: ${value.error.message}`);
    if (!value.ok || typeof value.ok !== "object" || Array.isArray(value.ok)) throw new Error("invalid admin reply");
    return value.ok;
  }
  return value?.welcome;
}
const matches = (x) => x?.version === 5 && x.state === state && x.mount === mount && x.proto === "nfs" && x.port === 0;
const timer = setTimeout(() => client.destroy(new Error("admin request timed out")), Number(timeout));
try {
  const welcome = await exchange({ hello: { client: "pp" } });
  if (!matches(welcome) || !Array.isArray(welcome.ops) || !["status", op].every((verb) => welcome.ops.includes(verb))) throw new Error("wrong local NFS endpoint or unsupported admin operation");
  const status = await exchange({ id: 1, status: {} });
  if (!matches(status) || status.socket !== socket || status.build_version !== "v0.8.0" || !Number.isSafeInteger(status.pid) || status.pid <= 0) throw new Error("wrong local daemon build or endpoint");
  // Status does not expose GitRemotes. Refuse inferred defaults or client-only configuration.
  const args = execFileSync("ps", ["-ww", "-p", String(status.pid), "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim().split(/\s+/);
  if (!/^(?:.*\/)?ovnfs$/.test(args[0]) || !args.includes("serve") || args.filter((a) => /^--(?:no-)?git-remotes(?:=|$)/.test(a)).join(" ") !== "--no-git-remotes") throw new Error("start the configured OVNFS daemon explicitly with serve --no-git-remotes");
  console.log(JSON.stringify(op === "status" ? status : await exchange({ id: 2, [op]: JSON.parse(raw) })));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  client.destroy();
}
