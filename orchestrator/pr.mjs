// Pull request follow-up. Everything read from GitHub is attacker-chosen text:
// only a fixed set of fields is kept, names are sanitised, bodies never copied.
import { sh } from "./lib.mjs";

const GH_TIMEOUT = 10_000;
const NAME_LIMIT = 80;

export function validPrUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})$/.exec(url ?? "");
  const nameOk = (s) => s !== "." && s !== ".." && /^[A-Za-z0-9._-]+$/.test(s);
  return Boolean(m && nameOk(m[1]) && nameOk(m[2]));
}

/** The report's first-line `PR:` URL; `{ note }` when one is present but unusable. */
export function prLine(report) {
  const first = report.split("\n")[0] ?? "";
  if (!first.startsWith("PR:")) return { url: null };
  const value = first.slice(3).trim();
  return validPrUrl(value) ? { url: value } : { url: null, note: "the report's `PR:` line is not a https://github.com/<owner>/<repo>/pull/<number> URL and was ignored" };
}

/** `{ host, repo }` (lower-cased) of a GitHub remote URL; null off GitHub. */
export function parseRemote(origin) {
  const o = String(origin ?? "").trim();
  let host, rest, m;
  if ((m = /^https?:\/\/([^/]+)\/(.*)$/.exec(o))) { host = m[1].split("@").pop(); rest = m[2]; }
  else if ((m = /^ssh:\/\/([^/]+)\/(.*)$/.exec(o))) { host = m[1].split("@").pop().split(":")[0]; rest = m[2]; }
  else if ((m = /^[^@:/]+@([^:]+):(.*)$/.exec(o))) { host = m[1]; rest = m[2]; }
  else return null;
  host = host.toLowerCase();
  if (!host.split(/[.:]/).includes("github")) return null;
  rest = rest.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = rest.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { host, repo: `${parts[0]}/${parts[1]}`.toLowerCase() };
}
export const normalizeOrigin = (o) => parseRemote(o)?.repo ?? null;
export const hostOf = (o) => parseRemote(o)?.host ?? "github.com";

function gh(host, args) {
  const env = host && host !== "github.com" ? { GH_HOST: host } : undefined;
  return sh(["gh", ...args], undefined, undefined, { timeout: GH_TIMEOUT, env });
}

export const sanitize = (s) => [...String(s ?? "")].filter((c) => !/[\u0000-\u001f\u007f-\u009f]/.test(c)).slice(0, NAME_LIMIT).join("").trim();

const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];

/**
 * Reduces `gh pr view --json …` to a summary, or `{ ignored }` when the head
 * branch or head repository is not the thread's (matching the head repo, not
 * the URL, keeps fork workflows working).
 */
export function reduce(json, branch, origin) {
  const v = JSON.parse(json);
  if (!branch) return { ignored: "the thread has no branch" };
  if (v.headRefName !== branch) return { ignored: "its head branch is not the thread's branch" };
  const head = `${v.headRepositoryOwner?.login ?? ""}/${v.headRepository?.name ?? ""}`.toLowerCase();
  if (normalizeOrigin(origin) !== head) return { ignored: "its head repository is not the thread's `origin`" };
  const failing = [...new Set((v.statusCheckRollup ?? [])
    .filter((c) => FAILED.includes(String(c.conclusion || c.state || "").toUpperCase()))
    .map((c) => sanitize(c.name || c.context)).filter(Boolean))].sort();
  const comments = v.comments ?? [];
  const commenters = [...new Set(comments.map((c) => sanitize(c.author?.login)).filter(Boolean))].sort();
  const activity = {};
  for (const c of [...comments, ...(v.reviews ?? [])]) {
    const login = sanitize(c.author?.login);
    if (login) activity[login] = (activity[login] ?? 0) + 1;
  }
  return {
    summary: {
      state: sanitize(v.state).toUpperCase(), review_decision: sanitize(v.reviewDecision).toUpperCase(),
      failing_checks: failing, comment_count: comments.length, commenters, activity, head_oid: sanitize(v.headRefOid),
    },
  };
}

const FIELDS = "state,reviewDecision,statusCheckRollup,comments,reviews,headRefName,headRefOid,headRepository,headRepositoryOwner";

export function view(url, origin) {
  if (!validPrUrl(url)) throw new Error("not a pull request URL");
  const host = hostOf(origin);
  const parts = url.slice("https://github.com/".length).split("/");
  const args = host === "github.com" ? ["pr", "view", "--json", FIELDS, "--", url] : ["pr", "view", "--json", FIELDS, "--repo", `${parts[0]}/${parts[1]}`, "--", parts[3]];
  const r = gh(host, args);
  if (!r.ok) throw new Error(`gh pr view: ${r.out}`);
  return r.stdout;
}

/** The login `gh` acts as: comments by it are the threads' own replies. */
export function ownLogin(origin) {
  const r = gh(hostOf(origin), ["api", "user", "--jq", ".login"]);
  return r.ok ? sanitize(r.stdout.trim()) || null : null;
}

/** The PR whose head is `branch` in `origin`: open, then merged, then closed, newest first. */
export function findByBranch(origin, branch) {
  const remote = parseRemote(origin);
  if (!remote || !branch) return null;
  const r = gh(remote.host, ["pr", "list", "--repo", remote.repo, `--head=${branch}`, "--state", "all", "--limit", "20", "--json", "url,state,createdAt"]);
  if (!r.ok) throw new Error(`gh pr list: ${r.out}`);
  const rank = (s) => ({ OPEN: 0, MERGED: 1 })[String(s).toUpperCase()] ?? 2;
  const listed = JSON.parse(r.stdout).filter((p) => validPrUrl(p.url));
  listed.sort((a, b) => rank(a.state) - rank(b.state) || String(b.createdAt).localeCompare(String(a.createdAt)));
  return listed[0]?.url ?? null;
}

/** With `pr_checks = false` CI results are left out, so a check-only change is no change at all. */
export const withChecks = (s, on = true) => (on ? s : { ...s, failing_checks: [] });

/** One line of what changed between two summaries; fields only. */
export function describeChange(old, s) {
  const parts = [`state ${s.state}`];
  if (s.review_decision) parts.push(`review ${s.review_decision}`);
  if (s.failing_checks.length) parts.push(`failing checks: ${s.failing_checks.join(", ")}`);
  parts.push(`${s.comment_count} comment(s)`);
  const fresh = s.commenters.filter((c) => !(old?.commenters ?? []).includes(c));
  if (fresh.length) parts.push(`new commenters: ${fresh.join(", ")}`);
  return parts.join("; ");
}

/** What happened between two polls, in the words `pr` routines use. */
export function prEvents(old, s, ownLoginName) {
  const events = [];
  if (!old && s.state === "OPEN") events.push("opened");
  if (s.failing_checks.length && (!old || JSON.stringify(old.failing_checks) !== JSON.stringify(s.failing_checks))) events.push("checks-failed");
  const othersGrew = Object.entries(s.activity).some(([login, n]) => login !== ownLoginName && n > (old?.activity?.[login] ?? 0));
  const decisionChanged = (!old || old.review_decision !== s.review_decision) && s.review_decision && s.review_decision !== "REVIEW_REQUIRED";
  if (othersGrew || decisionChanged) events.push("review");
  if (s.state === "MERGED" && (!old || old.state !== "MERGED")) events.push("merged");
  return events;
}

export function prEventPhrase(events, s) {
  if (events.includes("merged")) return "PR merged";
  if (s.state === "CLOSED") return "PR closed";
  if (events.includes("checks-failed")) return "PR checks failing";
  if (events.includes("review")) return "PR review activity";
  if (events.includes("opened")) return "PR opened";
  return "PR updated";
}

/** The prompt a `pr` routine sends: its text plus facts this program generated. */
export function prRoutinePrompt(name, body, url, events, s) {
  const facts = [];
  if (events.includes("checks-failed")) facts.push(`${s.failing_checks.length} check(s) fail (\`gh pr checks ${url}\`)`);
  if (events.includes("review")) facts.push(`${s.comment_count} comment(s), review ${s.review_decision ? s.review_decision.toLowerCase() : "none"} (\`gh pr view ${url} --comments\`)`);
  if (events.includes("opened")) facts.push("it was opened");
  if (events.includes("merged")) facts.push("it was merged");
  return `[pp routine ${name}] Your pull request ${url} changed: ${facts.join("; ")}.\n\n${body.trim()}`;
}

/** PRs a report names per `owner/repo`, except the tracked one. */
export function reportRefs(report, origin, except) {
  const refs = new Map();
  const add = (repo, n) => { if (!refs.has(repo)) refs.set(repo, new Set()); refs.get(repo).add(n); };
  const own = normalizeOrigin(origin);
  for (const m of report.matchAll(/(^|[^A-Za-z0-9/_.&-])#(\d+)/g)) if (own) add(own, Number(m[2]));
  for (const word of report.split(/[\s()<>[\]`,;"]+/)) {
    const url = word.replace(/[.:!?]+$/, "");
    if (!validPrUrl(url)) continue;
    const p = url.slice(19).split("/");
    add(`${p[0]}/${p[1]}`.toLowerCase(), Number(p[3]));
  }
  if (validPrUrl(except)) {
    const p = except.slice(19).split("/");
    refs.get(`${p[0]}/${p[1]}`.toLowerCase())?.delete(Number(p[3]));
  }
  for (const [k, v] of refs) if (!v.size) refs.delete(k);
  return refs;
}

/** Numbers of the open PRs in `repo` the `gh` user opened. */
export function openOwnNumbers(repo, host) {
  const r = gh(host, ["pr", "list", "--repo", repo, "--state", "open", "--author", "@me", "--limit", "100", "--json", "number"]);
  if (!r.ok) throw new Error(`gh pr list: ${r.out}`);
  return new Set(JSON.parse(r.stdout).map((p) => p.number));
}
