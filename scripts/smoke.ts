// End-to-end check of the bridge (M2b postman). Spawns its own daemon(s) against a throwaway git project.
//   npm run smoke
// A: pipeline over mail with the poll fallback (wait_for_mail), gates, ask_human-as-mail, human mail, dedupe, restart.
// D: meeting rounds → approved plan → task DAG with parallel tasks, one task per agent at a time, leases, scoped commits.
// B: stdio proxy as Claude doorbell, writing into a fake CLAUDE_CODE_MESSAGING_SOCKET named pipe.
// C: Codex Stop hook doorbell against fake transcripts.
// E: codex-queue doorbell (`codex queue` via a fake CLI in an isolated CODEX_HOME): hook registers and
//    doesn't park, mail → codex queue, dedupe against Codex's queue DB, failure → hook parks as fallback.
// F: MCP prompts and inference, isolated CLI, version refresh, drift reports and doorbell recovery.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { smokeCli } from "./p2-cli-smoke.js";
import { smokeAcp } from "./acp-smoke.js";
import { smokeAcpProcess } from "./acp-process-smoke.js";
import { smokeMemberNotes } from "./member-notes-smoke.js";

const PORT = Number(process.env.SMOKE_PORT ?? 7891);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-"));
const sh = (...args: string[]) => execFileSync("git", ["-C", proj, ...args], { encoding: "utf8" }).trim();
sh("init", "-q");
sh("config", "user.name", "bridge-smoke");
sh("config", "user.email", "bridge-smoke@example.invalid");
sh("config", "core.autocrlf", "false");
fs.writeFileSync(path.join(proj, "README.md"), "smoke\n");
sh("add", "-A");
sh("commit", "-qm", "init");
fs.writeFileSync(
  path.join(proj, "bridge.config.yaml"),
  `agents: { claude: {}, codex: {}, pbot: {}, hbot: {}, hbot2: {}, hbot3: { doorbell: codex-hook }, qbot: { product: codex } }
pipeline:
  - { id: plan, role: 规划, agent: claude, gate: true, owns: [DESIGN.md] }
  - { id: implement, role: 编码, agent: codex }
  - { id: review, role: 审查, agent: claude, gate: true, on_reject: implement }
wait: { poll_seconds: 2, stale_after_seconds: 30, offline_after_seconds: 60 }
mail: { ring_retry_seconds: 12 }
notify: { enabled: false }
`,
);

// A fake Codex CLI: logs its argv; fails while <CODEX_HOME>/fail exists. Never touches the real Codex.
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-codex-"));
const fakeCodex = path.join(codexHome, "fake-codex.mjs");
const fakeCodexLog = path.join(codexHome, "calls.jsonl");
const fakeQueueHold = path.join(codexHome, "hold-queue");
const fakeVersionFile = path.join(codexHome, "version");
const fakeVersionLog = path.join(codexHome, "version-probes.log");
const fakeVersionHold = path.join(codexHome, "hold-version");
fs.writeFileSync(fakeVersionFile, "9.1.2");
fs.writeFileSync(
  fakeCodex,
  `import fs from "node:fs";
const dir = ${JSON.stringify(codexHome)};
if (process.argv[2] === "--version") {
  const version = fs.readFileSync(${JSON.stringify(fakeVersionFile)}, "utf8");
  fs.appendFileSync(${JSON.stringify(fakeVersionLog)}, version + "\\n");
  while (fs.existsSync(${JSON.stringify(fakeVersionHold)})) await new Promise((resolve) => setTimeout(resolve, 20));
  if (version === "fail") process.exit(1);
  console.log("codex-cli " + version);
  process.exit(0);
}
if (process.argv[2] === "queue" && process.argv[3] === "--help") { console.log("--thread --message"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(fakeCodexLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (fs.existsSync(dir + "/fail")) { process.stderr.write("boom"); process.exit(1); }
while (fs.existsSync(${JSON.stringify(fakeQueueHold)})) await new Promise((resolve) => setTimeout(resolve, 20));
const i = process.argv.indexOf("--thread");
console.log("Queued message m-1 for thread " + process.argv[i + 1] + ".");
`,
);
const codexCalls = () => (fs.existsSync(fakeCodexLog) ? fs.readFileSync(fakeCodexLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const versionProbes = () => fs.existsSync(fakeVersionLog) ? fs.readFileSync(fakeVersionLog, "utf8").trim().split("\n") : [];

let daemon: ChildProcess;
async function startDaemon(project = proj, wakeGrace = "6", versionEnv: Record<string, string> = {}) {
  daemon = spawn(process.execPath, ["--import", "tsx", "src/daemon.ts", "--project", project, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      // Panel snapshots can run git status while the fixture stages a file in the same repository.
      GIT_OPTIONAL_LOCKS: "0",
      BRIDGE_NOTIFY: "0", BRIDGE_WAKE_GRACE_SECONDS: wakeGrace, BRIDGE_UNREACHABLE_ALERT_SECONDS: "2",
      BRIDGE_WAKE_TURN_EXTRA_SECONDS: "0",
      BRIDGE_CODEX_BIN: fakeCodex, CODEX_HOME: codexHome, ...versionEnv,
    },
  });
  let out = "";
  daemon.stdout!.on("data", (d) => (out += d));
  daemon.stderr!.on("data", (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    if (out.includes("面板:")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon did not start:\n" + out);
}
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const child = daemon;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = setTimeout(() => child.kill(), 10_000).unref();
  if (child.connected) child.send("shutdown", (error) => { if (error) child.kill(); });
  else child.kill();
  await exited;
  clearTimeout(timeout);
}

async function connect(name: string, transport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"))) {
  const c = new Client({ name: `smoke-${name}`, version: "0.0.1" });
  await c.connect(transport);
  return c;
}
async function connectProxy(name: string) {
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["bin/bridge-mcp.mjs"],
    env: { BRIDGE_URL: BASE, TMP: proj, TEMP: proj, TMPDIR: proj },
  }));
  return client;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return JSON.parse(r.content[0].text);
}
const api = async (p: string, body?: unknown) => {
  // Synchronous CLI checks can block this process past the server's keep-alive timeout.
  const headers = new Headers({ connection: "close" });
  if (body !== undefined) headers.set("content-type", "application/json");
  const r = await fetch(BASE + p, { method: body === undefined ? "GET" : "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const state = async () => (await api("/api/state")).json;
const activity = (s: any, id: string) => s.agents.find((a: any) => a.id === id)?.activity;
const inboxItem = (s: any, kind: string, agent?: string) =>
  s.inbox.find((item: any) => item.kind === kind && (!agent || item.agent === agent));
const inboxContext = (s: any, item: any) => item && s.timeline.find((it: any) => it.type === item.ref.type &&
  (it.type === "round" ? it.meeting_id === item.ref.meeting_id && it.round === item.ref.round : it.id === item.ref.id));
let failed = false;
function check(cond: unknown, msg: string) {
  console.log(cond ? "ok  " : "FAIL", msg);
  if (!cond) failed = true;
}
const write = (f: string, s: string) => fs.writeFileSync(path.join(proj, f), s);
const task = (r: any) => r.mails?.find((m: any) => m.kind === "task" && !m.void)?.task;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitState(predicate: (snapshot: any) => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    const s = await state();
    if (predicate(s)) return s;
    await sleep(50);
  }
  throw new Error(message);
}
const hookLog = path.join(proj, "codex-stop-hook.jsonl");

function runHook(stdin: object, env: Record<string, string>): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, "bin/codex-stop-hook.mjs")], { env: { ...process.env, BRIDGE_URL: BASE, BRIDGE_HOOK_LOG: hookLog, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve({ out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(stdin));
  });
}

try {
  await startDaemon();

  // Prompts and implicit join go through the stdio proxy, where the native client name reaches the daemon.
  const nativeCodex = await connectProxy("codex-mcp-client");
  const prompts = await nativeCodex.listPrompts();
  const promptText = async (name: string, args?: Record<string, string>) => {
    const { messages } = await nativeCodex.getPrompt({ name, arguments: args });
    const message = messages[0];
    return message?.role === "user" && message.content.type === "text" ? message.content.text : "";
  };
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  check(prompts.prompts.map((p) => p.name).sort().join(",") === "inbox,join" &&
    nativeCodex.getServerVersion()?.version === version, "stdio advertises both prompts and the package version");
  check((await promptText("join")).includes("不填 agent_id") && (await promptText("join", { agent_id: "qbot" })).includes('agent_id = "qbot"') &&
    (await promptText("inbox")).includes("fetch_inbox"), "prompt get returns correct user texts, with and without an explicit identity");
  check((await call(nativeCodex, "join", {})).agent_id === "qbot" && (await state()).agents.find((a: any) => a.id === "qbot")?.product?.client === "codex-mcp-client",
    "implicit join selects the only configured Codex product from the native proxy client name");
  const anotherCodex = await connectProxy("codex-mcp-client");
  const occupied = await call(anotherCodex, "join", {});
  check(occupied.error?.includes("已被另一个会话占用") && occupied.bound_session, "implicit join preserves occupied-identity protection");
  await anotherCodex.close();
  await call(nativeCodex, "leave", { agent_id: "qbot" });
  await nativeCodex.close();

  // ===== A: mail flow with the poll fallback =====
  console.log("— A: pipeline over mail (poll fallback)");
  let claude = await connect("claude");
  let codex = await connect("codex");
  const imposter = await connect("imposter");
  const noMatch = await call(imposter, "join", {});
  check(noMatch.error?.includes("没有成员") && noMatch.candidates?.includes("claude") && noMatch.candidates?.includes("codex"),
    "implicit join with no match lists available identities");
  const j = await call(claude, "join", { agent_id: "claude" });
  check(j.roles?.length === 2 && j.doorbell === "poll", "claude joined, no doorbell → poll");
  check(
    j.protocol?.[0].includes("ToolSearch") &&
      ["submit_handoff", "submit_meeting_turn", "fetch_inbox", "ack", "report_progress"].every((tool) => j.protocol[0].includes(tool)),
    "join tells delayed-loading clients to load all five tools before fetching mail",
  );
  check(!(await call(codex, "join", { agent_id: "codex" })).error, "codex joined");
  const notJoined = activity(await state(), "pbot");
  check(notJoined?.state === "never-joined" && notJoined.evidence && notJoined.since === null, "Office reports never-joined with evidence");
  check((await call(imposter, "join", { agent_id: "claude" })).error, "duplicate identity rejected");
  check((await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.length === 0, "empty inbox");
  check((await call(claude, "wait_for_mail", { agent_id: "claude" })).status === "keep_waiting", "idle wait_for_mail → keep_waiting");

  const claudeWait = call(claude, "wait_for_mail", { agent_id: "claude" });
  check((await api("/api/runs", { goal: "做一个 hello 程序" })).status === 200, "run started");
  check((await api("/api/runs", { goal: "again" })).status === 409, "second start rejected while open");
  let t = task(await claudeWait);
  check(t?.stage?.id === "plan" && t.stage.needs_approval, "blocked wait_for_mail woken with plan task");
  write("DESIGN.md", "# hello\nprint hello\n");
  await call(claude, "post_note", { agent_id: "claude", topic: "约定", text: "用 node 写" });
  let sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "写了设计", files_changed: ["DESIGN.md"], notes_for_next: "按 DESIGN.md 实现" });
  check(sub.status === "submitted" && /^[0-9a-f]{40}$/.test(sub.commit), "plan handoff auto-committed");
  let s = await state();
  check(s.run.status === "awaiting_approval", "run waits at plan gate");
  check(s.timeline.some((x: any) => x.type === "handoff" && x.gate?.attempt_id === s.live.id && x.gate.reject_to === "plan"), "the gated handoff carries its approval card in the timeline");
  const gateItem = inboxItem(s, "handoff_gate");
  const gateCard = inboxContext(s, gateItem);
  check(gateCard?.gate?.attempt_id === s.live.id && gateItem.id === "gate-" + s.live.id && gateItem.urgency === "high" &&
    gateItem.target.view === "meeting" && gateItem.target.anchor === "handoff-" + gateCard.id, "inbox gate points to its full handoff card");
  check(activity(s, "claude")?.state === "awaiting_you" && activity(s, "claude")?.since === gateCard?.at, "Office uses the submitted handoff as evidence of a gate");
  check(s.mail.find((m: any) => m.kind === "task" && m.to === "claude")?.status === "acked", "task mail auto-acked by submit_handoff");

  const codexWait = call(codex, "wait_for_mail", { agent_id: "codex" });
  await api(`/api/attempts/${s.live.id}/decide`, { action: "approve", note: "输出要带感叹号" });
  t = task(await codexWait);
  check(
    t?.stage.id === "implement" && t.feedback?.kind === "approval_note" && t.feedback.user_requirements[0].includes("感叹号") && t.input_handoff?.summary === "写了设计",
    "codex woken with implement task + structured approval note",
  );

  const asked = await call(codex, "ask_human", { agent_id: "codex", question: "用 console.log 吗？" });
  check(asked.status === "submitted", "ask_human returns immediately");
  s = await state();
  check(s.questions.length === 1, "question visible on panel");
  const questionItem = inboxItem(s, "question");
  const questionCard = inboxContext(s, questionItem);
  check(questionCard?.id === s.questions[0].id && questionItem.target.view === "chat" &&
    questionItem.target.anchor === "question-" + questionCard.id && !inboxItem(s, "handoff_gate"),
    "answered gate disappears and the pending question links to its chat card");
  const coding = activity(s, "codex");
  check(coding?.state === "working" && coding.evidence && coding.since === s.live.started_at &&
    coding.link?.anchor === "task-" + s.live.task_id, "Office derives working from the fetched implementation attempt");
  const ansWait = call(codex, "wait_for_mail", { agent_id: "codex" });
  await api(`/api/questions/${s.questions[0].id}/answer`, { answer: "是" });
  const ans = await ansWait;
  check(ans.mails?.some((m: any) => m.kind === "answer" && m.body.includes("是")), "answer arrives as mail");
  check(!inboxItem(await state(), "question"), "the answered question disappears from the inbox");

  // Chat: the per-agent message box and the chat room are chat mail (no ack); the mail status is the receipt.
  const boxed = await api("/api/mail", { to: "codex", text: "顺便加个注释" });
  const inbox = await call(codex, "fetch_inbox", { agent_id: "codex" });
  const hm = inbox.mails.find((m: any) => m.kind === "chat");
  check(hm?.id === boxed.json.id && !hm.ack_required && hm.chat.text === "顺便加个注释" && hm.chat.from === "human", "panel message box → chat mail, no ack required");
  s = await state();
  check(s.chat.at(-1).receipts[0].status === "fetched" && s.chat.at(-1).receipts[0].read_at, "fetching a chat mail is the read receipt");
  check((await api("/api/chat", { text: "没有点名" })).status === 409, "human chat without @ is refused");
  check((await api("/api/chat", { text: "x", mentions: ["nobody"] })).status === 409, "unknown mention refused");
  const room = await api("/api/chat", { text: "@claude你好，@codex 也看一下" });
  check(JSON.stringify(room.json.delivered_to?.sort()) === '["claude","codex"]', "@names found in Chinese text (no space after the name)");
  const roomMail = (await call(codex, "fetch_inbox", { agent_id: "codex" })).mails.find((m: any) => m.kind === "chat");
  check(roomMail?.chat.earlier.some((x: any) => x.text === "顺便加个注释"), "chat mail carries the earlier conversation");
  const said = await call(codex, "say", { agent_id: "codex", text: "收到，等我写完 T1", reply_to: roomMail.chat.message_id, mentions: ["claude"] });
  check(said.ok && JSON.stringify(said.delivered_to) === '["claude"]', "say with mentions wakes the mentioned agent");
  const claudeChat = (await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.filter((m: any) => m.kind === "chat");
  check(claudeChat.length === 2 && claudeChat[1].chat.reply_to?.id === roomMail.chat.message_id, "claude gets the room message and codex's reply");
  const back = await call(claude, "say", { agent_id: "claude", text: "好的", reply_to: said.message_id });
  check(JSON.stringify(back.delivered_to) === '["codex"]', "replying to an agent's message reaches it without @");
  check((await call(claude, "say", { agent_id: "claude", text: "只给用户看" })).delivered_to.length === 0, "say without mentions is for the human only");
  const quiet = await call(claude, "say", { agent_id: "claude", text: "就聊到这儿", reply_to: said.message_id, wake: false });
  check(quiet.ok && quiet.delivered_to.length === 0, "say wake=false replies without waking the author");
  let muted: any;
  for (let i = 0; i < 6 && !muted?.muted; i++) muted = await call(claude, "say", { agent_id: "claude", text: "@codex 再聊一句 " + i });
  check(muted.muted?.[0] === "codex" && muted.delivered_to.length === 0, "agents stop waking each other after max_agent_turns without the human");
  check((await call(codex, "get_context", { agent_id: "codex" })).chat.some((x: any) => x.text === "只给用户看"), "get_context includes recent chat");
  await call(codex, "fetch_inbox", { agent_id: "codex" }); // drain the chat mail

  const d1 = await call(codex, "send_mail", { agent_id: "codex", to: "claude", subject: "提醒", body: "x", mail_id: "dup-1" });
  const d2 = await call(codex, "send_mail", { agent_id: "codex", to: "claude", subject: "提醒", body: "x", mail_id: "dup-1" });
  check(d1.duplicate === false && d2.duplicate === true, "same mail_id is delivered once (dedupe)");

  write("hello.js", "console.log('hello')\n");
  write("extra.txt", "not declared\n");
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "实现 v1", files_changed: ["hello.js"] });
  check(sub.next === "claude/review", "implement → review");
  s = await state();
  check(s.handoffs.at(-1).scope_notes.some((n: string) => n.includes("extra.txt")), "undeclared changed file flagged in scope notes");

  let cm = await call(claude, "fetch_inbox", { agent_id: "claude" });
  t = task(cm);
  check(t?.stage.id === "review" && cm.mails.some((m: any) => m.id === "dup-1"), "claude gets review task and codex's note");
  const reviewing = activity(await state(), "claude");
  check(reviewing?.state === "reviewing" && reviewing.evidence, "Office recognizes a fetched review stage");
  const ctx = await call(claude, "get_context", { agent_id: "claude", last_n: 1 });
  check(
    ctx.handoffs_total === 2 && ctx.recent_handoffs.length === 1 && ctx.older_handoffs.length === 1 && ctx.notes.some((n: any) => n.text === "用 node 写"),
    "get_context returns only the last N handoffs in full",
  );
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "缺感叹号", verdict: "reject", review_comments: ["输出没有感叹号"], observations: ["变量名可以更清楚"] });
  check(/^[0-9a-f]{40}$/.test(sub.commit), "review with no file changes still gets an (empty) commit");
  s = await state();
  await api(`/api/attempts/${s.live.id}/decide`, { action: "reject", note: "按审查意见改" });
  t = task(await call(codex, "wait_for_mail", { agent_id: "codex" }));
  check(
    t?.stage.id === "implement" && t.feedback.kind === "rework" && t.feedback.user_requirements[0] === "按审查意见改" &&
      t.feedback.blocking[0] === "输出没有感叹号" && t.feedback.observations[0] === "变量名可以更清楚",
    "rework feedback split into user requirements / blocking / observations",
  );
  check(t.input_handoff?.from === "claude/review" && t.input_handoff.summary === "缺感叹号" && t.input_handoff.verdict === "reject" &&
    !("review_comments" in t.input_handoff) && !("observations" in t.input_handoff) && t.instructions.includes("不再重复"),
    "rework input_handoff drops the review comments already in feedback");
  write("hello.js", "console.log('hello!')\n");
  write("DESIGN.md", "# hello\nprint hello!\n");
  await call(codex, "submit_handoff", { agent_id: "codex", summary: "加了感叹号", files_changed: ["hello.js", "DESIGN.md"] });
  s = await state();
  check(s.handoffs.at(-1).scope_notes.some((n: string) => n.includes("plan") && n.includes("DESIGN.md")), "touching another stage's file flagged");
  t = task(await call(claude, "wait_for_mail", { agent_id: "claude" }));
  check(t?.stage.id === "review" && t.feedback?.kind === "carried" && t.feedback.user_requirements[0] === "按审查意见改", "re-review carries this round's user requirements");
  check(t.feedback.blocking[0] === "输出没有感叹号" && t.feedback.observations.length === 0 && t.input_handoff?.summary === "加了感叹号" &&
    t.stage.instructions === null && (t.instructions.match(/verdict 填 approve/g) ?? []).length === 1,
    "re-review keeps blocking issues and drops the old review's observations; a stage without its own rule gets the generic one once");
  await call(claude, "submit_handoff", { agent_id: "claude", summary: "通过", verdict: "approve" });
  s = await state();
  await api(`/api/attempts/${s.live.id}/decide`, { action: "approve", note: "" });
  s = await state();
  check(s.run.status === "done" && !s.live, "run done after final approval");
  const idleClaude = s.agents.find((a: any) => a.id === "claude");
  check(idleClaude?.activity.state === "idle" && idleClaude.lastSeenAt && idleClaude.activity.since === idleClaude.lastSeenAt,
    "Office uses the same latest activity timestamp as member details after a handoff");
  const commits = sh("log", "--oneline").split("\n").filter((l) => l.includes("[bridge]"));
  check(commits.length === 5 && commits.some((c) => c.includes("审查通过")), `5 bridge commits incl. review conclusions (got ${commits.length})`);
  check(!sh("status", "--porcelain").includes(".bridge"), ".bridge/ is not tracked or dirty in git");
  const [panel, mainAsset, cssAsset, oldPanel, oldScript, oldStyle] = await Promise.all(
    ["/", "/panel/js/main.js", "/panel/app.css", "/v1", "/panel/v1/room.js", "/panel/v1/room.css"].map((p) => fetch(BASE + p)),
  );
  const panelHtml = await panel.text();
  check(panel.ok && panelHtml.includes('type="module" src="/panel/js/main.js"') &&
    mainAsset.ok && /javascript/i.test(mainAsset.headers.get("content-type") || "") && cssAsset.ok,
    "panel serves its ES module with JavaScript MIME type");
  const views = panelHtml.match(/<section\b[^>]*\bid="view-(?:home|folder|chat|office)"[^>]*>/g) ?? [];
  check(views.length === 4 && views.every((view) => /\s+hidden(?:\s|>)/.test(view)),
    "all four views start hidden so a direct link mounts only its own view");
  // The chat view always sits (hidden) inside main, so a bare `.main:has(.chat-page)` locked scrolling on every page.
  const panelCss = await cssAsset.text();
  check(/\.main:has\(>\s*#view-chat:not\(\[hidden\]\)\)\s*\{\s*overflow:\s*hidden/.test(panelCss) &&
    !/\.main:has\(\.chat-page\)/.test(panelCss),
    "main stops scrolling only while the chat view is shown");
  check(oldPanel.ok && (await oldPanel.text()).includes("/panel/v1/room.js") && oldScript.ok && oldStyle.ok, "meeting-room fallback still served at /v1");
  check((await (await fetch(BASE + "/classic")).text()).includes("AI Bridge"), "classic panel still served at /classic");
  const model = await import(new URL("../panel/js/model.js", import.meta.url).href);
  check(model.wakePhrase("claude", "claude-code") === "/bridge" && model.wakePhrase("qbot", "codex") === "$bridge" &&
    model.wakePhrase("other").includes('agent_id="other"'), "copyable wake prompts match each product with an explicit fallback identity");
  check(JSON.stringify(model.recipients(["claude", "codex"], ["codex"], null, "@claude你好")) === '["codex","claude"]' &&
    model.recipients(["claude", "codex"], [], null, "@所有人开始").length === 2 &&
    model.recipients(["claude", "claude-review"], [], null, "@CLAUDE-REVIEW你好")[0] === "claude-review" &&
    model.recipients(["cl", "claude"], [], null, "@claudex").length === 0,
    "panel composer resolves Chinese suffixes, aliases and longest known mentions like the daemon");
  check(model.deliveryHint([{ id: "claude", status: "working", doing: [{ status: "in_progress" }] }], [], null, "@claude你好").includes("消息排队到这一轮结束") &&
    model.receiptLabel({ status: "rung", waitingForTurn: true })[0] === "排队中，等它这一轮结束", "panel uses the busy delivery hint and receipt label");

  await api("/api/runs", { goal: "第二个任务" });
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.stage.id === "plan", "second run: claude takes plan");
  await stopDaemon();
  await startDaemon();
  s = await state();
  check(s.recentRuns.length === 2 && s.run.goal === "第二个任务", "runs persisted across restart");
  const claudeTransport = new StreamableHTTPClientTransport(new URL(BASE + "/mcp"));
  claude = await connect("claude-again", claudeTransport);
  await call(claude, "join", { agent_id: "claude" });
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.resumed === true && t.stage.id === "plan", "in-progress stage re-sent as mail after restart + rejoin");
  await claudeTransport.terminateSession();
  await claude.close();
  claude = await connect("claude-new-session");
  const recovered = await call(claude, "fetch_inbox", { agent_id: "claude" });
  check(recovered.identity_recovered === true && recovered.identity_note.includes("恢复 claude") && task(recovered)?.resumed, "first tool call rebinds a closed session and resumes its live task");
  const recoveredAgain = await call(claude, "get_context", { agent_id: "claude" });
  check(recoveredAgain.current_round?.stage === "plan" && !recoveredAgain.identity_recovered, "recovery is reported only once");

  // Identity: a blocked join explains how to proceed; the panel can release; the agent can leave.
  const intruder = await connect("intruder");
  const blocked = await call(intruder, "join", { agent_id: "claude" });
  check(blocked.error && typeof blocked.auto_release_in_seconds === "number" && blocked.options?.length >= 2, "blocked join reports idle time, auto-release and options");
  check((await api("/api/agents/claude/release", {})).status === 200, "panel releases the identity");
  check((await call(claude, "fetch_inbox", { agent_id: "claude" })).error, "released session can no longer act");
  check(!(await call(intruder, "join", { agent_id: "claude" })).error, "new session joins without takeover after release");
  check(!(await call(intruder, "leave", { agent_id: "claude" })).error, "leave frees the identity");
  check((await call(claude, "get_context", { agent_id: "claude" })).error, "a deliberate leave requires the next session to join");
  await call(claude, "join", { agent_id: "claude" });
  await api("/api/runs/stop", {});

  // ===== D: meeting → task DAG, file leases, scoped commits =====
  console.log("— D: meeting → task DAG, leases, scoped commits");
  codex = await connect("codex-again"); // its first session died with the daemon restart above
  await call(codex, "join", { agent_id: "codex" });
  const meetingOf = (r: any) => r.mails?.find((m: any) => m.kind === "meeting" && !m.void)?.meeting;
  const mt = await api("/api/meetings", { topic: "①「（拆成并行任务）」：详细目标", participants: ["claude", "codex"] });
  check(mt.status === 200, "meeting started");
  const mid = mt.json.meeting_id;
  check((await api("/api/runs", { goal: "x" })).status === 409, "pipeline run refused while a meeting is open");
  let mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(mm?.kind === "proposal" && mm.round === 1 && mm.meeting_id === mid, "claude invited to round 1 (proposal)");
  const proposalA = "## 方案 A\n按目录拆。每个模块归给一个人。";
  const proposalB = "方案 B：按功能拆" + "，补充详细说明".repeat(40);
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: proposalA });
  check((await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "again" })).error, "second turn in the same round rejected");
  s = await state();
  const owing = activity(s, "codex");
  check(s.meeting.status === "collecting", "meeting waits for codex");
  check(owing?.state === "meeting" && owing.since && owing.evidence &&
    owing.link?.anchor === "round-" + mid + "-1", "Office identifies the member owing a turn and links to the current round");
  mm = meetingOf(await call(codex, "fetch_inbox", { agent_id: "codex" }));
  await call(codex, "submit_meeting_turn", { agent_id: "codex", meeting_id: mid, content: proposalB, tasks: [{ id: "T1", title: "草案", owner: "codex" }] });
  s = await state();
  check(s.meeting.status === "review" && s.meeting.turns.length === 2, "all proposals in → waits for the human");
  const stalledItem = inboxItem(s, "meeting_stalled");
  check(inboxContext(s, stalledItem)?.status === "review" && stalledItem.target.anchor === "round-" + mid + "-1", "a completed round needs a human decision");
  await api(`/api/meetings/${mid}/next`, { action: "critique", note: "重点看能不能并行" });
  mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(
    mm?.kind === "critique" && mm.round === 2 && mm.previous_rounds[0].turns.length === 2 && mm.human_note === "重点看能不能并行",
    "critique round carries every proposal and the human's note",
  );
  const proposals = mm?.previous_rounds[0].turns;
  const ownA = proposals?.find((turn: any) => turn.agent === "claude");
  check(ownA?.yours === true && ownA.summary === "按目录拆。" && !("content" in ownA) && mm.instructions.includes("yours") &&
    proposals?.find((turn: any) => turn.agent === "codex")?.content === proposalB &&
    proposals?.find((turn: any) => turn.agent === "codex")?.tasks[0].title === "草案", "the preceding round keeps others' full text and drafts, and only summarizes your own turn");
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "同意 B" });
  await call(codex, "join", { agent_id: "codex" }); // a rejoin may be a new conversation that never saw its own proposal
  const afterRejoin = meetingOf(await call(codex, "fetch_inbox", { agent_id: "codex" }))?.previous_rounds[0].turns;
  check(afterRejoin?.find((turn: any) => turn.agent === "codex")?.content === proposalB &&
    afterRejoin?.find((turn: any) => turn.agent === "claude")?.content === proposalA && !afterRejoin.some((turn: any) => turn.yours),
    "after a rejoin your own previous turn comes back in full");
  await call(codex, "submit_meeting_turn", { agent_id: "codex", meeting_id: mid, content: "同意" });
  await api(`/api/meetings/${mid}/next`, { action: "finalize", note: "" });
  check(!meetingOf(await call(codex, "fetch_inbox", { agent_id: "codex" })), "final round goes to the facilitator only");
  mm = meetingOf(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(mm?.kind === "final", "facilitator gets the final round");
  const earlier = mm?.previous_rounds.find((round: any) => round.round === 1)?.turns;
  check(earlier?.length === 2 && earlier.every((t: any) => t.summary && !("content" in t) && !("tasks" in t) && !("decisions" in t)) &&
    earlier.find((t: any) => t.agent === "claude")?.summary === "按目录拆。" &&
    earlier.find((t: any) => t.agent === "codex")?.summary.length === 160 &&
    mm.previous_rounds.find((round: any) => round.round === 2)?.turns.some((t: any) => t.agent === "codex" && t.content === "同意") &&
    mm.previous_rounds.find((round: any) => round.round === 2)?.turns.some((t: any) => t.agent === "claude" && t.yours && t.summary === "同意 B" && !("content" in t)),
    "final mail summarizes each older speaker and carries the previous critique in full (yours as a summary)");
  const cyc = await call(claude, "submit_meeting_turn", {
    agent_id: "claude", meeting_id: mid, content: "x",
    tasks: [{ id: "T1", title: "a", owner: "claude", depends_on: ["T2"] }, { id: "T2", title: "b", owner: "nobody", depends_on: ["T1"] }],
  });
  check(cyc.error && cyc.problems.some((p: string) => p.includes("成环")) && cyc.problems.some((p: string) => p.includes("nobody")), "bad plan rejected (cycle, unknown owner)");
  const plan = [
    { id: "T1", title: "做 a", description: "写 a/one.txt", owner: "claude", reviewer: "codex", paths: ["a/**"] },
    { id: "T2", title: "做 b", description: "写 b/one.txt", owner: "codex", paths: ["b/"] },
    { id: "T4", title: "做 d", description: "写 d/one.txt", owner: "codex", paths: ["d/**"] },
    { id: "T3", title: "合并", description: "写 c.txt", owner: "claude", depends_on: ["T1", "T2"], paths: ["c.txt"] },
  ];
  await call(claude, "submit_meeting_turn", { agent_id: "claude", meeting_id: mid, content: "最终方案：四个任务", decisions: [{ what: "按目录拆", why: "互不干扰" }], tasks: plan });
  s = await state();
  check(s.meeting.status === "awaiting_approval", "final plan waits for approval");
  const finalItem = inboxItem(s, "meeting_final");
  check(inboxContext(s, finalItem)?.kind === "final" && finalItem.target.view === "meeting" &&
    finalItem.target.anchor === "round-" + mid + "-3" && !inboxItem(s, "meeting_stalled"), "inbox final plan targets the approval round");
  write("IMPORTANT.md", "用户的反馈\n");
  sh("add", "--", "IMPORTANT.md");
  write("开工前新增.txt", "用户保留的未暂存文件\n");
  const appr = await api(`/api/meetings/${mid}/decide`, { action: "approve", note: "注意中文注释" });
  check(appr.status === 200 && /^doc\/meetings\/\d{4}-\d{2}-\d{2}-m\d+-拆成并行任务\.md$/.test(appr.json.doc_path) &&
    appr.json.doc_path.endsWith(`-m${mid}-拆成并行任务.md`), `approved → numbered, shortened minutes at ${appr.json.doc_path}`);
  const minutes = fs.readFileSync(path.join(proj, appr.json.doc_path), "utf8");
  check(minutes.includes("方案 A") && minutes.includes("| T3 | 合并 |") && minutes.includes("按目录拆 —— 互不干扰"), "minutes hold proposals, decisions and the task table");
  check(sh("log", "-1", "--format=%s", "--", appr.json.doc_path).includes("会议纪要") && !sh("status", "--porcelain").includes("doc/"), "minutes committed on their own");
  s = await state();
  check(!inboxItem(s, "meeting_final"), "the approved final plan disappears from the inbox");
  const folderId = "m" + mid;
  const folderPage = (await api("/api/folders?limit=1")).json;
  const folderNext = (await api("/api/folders?limit=1&before=" + encodeURIComponent(folderPage.next_before))).json;
  const folderDetail = (await api("/api/folders/" + folderId)).json;
  const roundDetail = (await api("/api/folders/" + folderId + "?round=1")).json;
  check(folderPage.folders[0].id === folderId && folderNext.folders[0].kind === "run" &&
    !s.folders_head.some((f: any) => f.id === "r" + appr.json.run_id) &&
    (await api("/api/folders/r" + appr.json.run_id)).status === 404,
    "folders page by activity and keep a meeting and its run together");
  check(folderDetail.meeting.doc_path === appr.json.doc_path && folderDetail.tasks.length === 4 &&
    folderDetail.events.some((event: any) => event.run_id === appr.json.run_id) &&
    folderDetail.rounds[0].turns[0].content.includes("最终方案") &&
    folderDetail.rounds.at(-1).turns[0].summary && !folderDetail.rounds.at(-1).turns[0].content &&
    roundDetail.rounds.at(-1).turns.some((turn: any) => turn.content === proposalA),
    "folder shows minutes, scoped events, active tasks, round summaries and on-demand full turns");
  check(s.now_playing.length === 3 && s.now_playing.every((item: any) => item.folder === folderId && item.stage_index === 0 && item.since),
    "all concurrently ready attempts are projected in the meeting folder");
  const ready = activity(s, "codex");
  check(ready?.state === "idle" && ready.evidence.includes("有任务待领取"), "an unfetched ready attempt does not count as working");
  const tk = (k: string) => s.tasks.find((x: any) => x.key === k);
  check(tk("T1").status === "active" && tk("T2").status === "active" && tk("T4").status === "active" && tk("T3").waiting === "等 T1、T2", "T1/T2/T4 start, T3 waits on its dependencies");
  check(s.leases.filter((l: any) => !l.released_at).length === 3 && s.leases.some((l: any) => l.glob === "b/**"), "task paths leased (b/ → b/**)");

  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.task?.key === "T1" && t.stage.id === "implement" && t.task.description.includes("注意中文注释") && t.meeting_minutes === appr.json.doc_path, "claude gets T1 with the approval note and minutes path");
  let ci = await call(codex, "fetch_inbox", { agent_id: "codex" });
  const codexTasks = ci.mails.filter((m: any) => m.kind === "task" && !m.void);
  check(codexTasks.length === 1 && codexTasks[0].task.task.key === "T2", "codex gets only one task at a time (T2, T4 held back)");
  const busyDoorbell = fetch(BASE + "/api/doorbell/wait?agent=codex&kind=codex-hook&timeout=10").then((r) => r.json());
  for (let i = 0; i < 30 && !(await state()).agents.find((a: any) => a.id === "codex").doorbellArmed; i++) await sleep(100);
  const queuedDuringT2 = await api("/api/mail", { to: "codex", text: "结束 T2 后再看" });
  check((await busyDoorbell).mailIds?.includes(queuedDuringT2.json.id), "a ring was delivered while codex was working on T2");
  const rungAtBusy = Date.now();

  const rc = await call(codex, "reserve_paths", { agent_id: "codex", globs: ["a/one.txt"], reason: "想顺手改" });
  check(rc.granted === false && rc.conflicts[0].held_by === "claude" && rc.conflicts[0].task === "T1", "lease conflict reports the holder");
  const conflictMail = (await call(claude, "fetch_inbox", { agent_id: "claude" })).mails.find((m: any) => m.kind === "system");
  check(conflictMail?.subject.includes("文件冲突"), "holder is told about the conflict");
  const rs = await call(codex, "reserve_paths", { agent_id: "codex", globs: ["shared/notes.md"], ttl_seconds: 60 });
  check(rs.granted === true, "free path reserved");
  const contextWithLease = await call(codex, "get_context", { agent_id: "codex" });
  check(
    contextWithLease.current_task?.key === "T2" &&
      contextWithLease.meeting?.minutes === appr.json.doc_path &&
      contextWithLease.leases.some((l: any) => l.glob === "shared/notes.md" && l.task === "T2"),
    "context combines the scheduled task, meeting minutes and its live file leases",
  );
  const releasedPath = await call(codex, "release_paths", { agent_id: "codex", globs: ["shared/notes.md"] });
  check(
    releasedPath.released?.includes("shared/notes.md") && !(await state()).leases.some((l: any) => l.glob === "shared/notes.md"),
    "releasing a temporary lease updates the panel state",
  );

  fs.mkdirSync(path.join(proj, "a"), { recursive: true });
  fs.mkdirSync(path.join(proj, "b"), { recursive: true });
  fs.mkdirSync(path.join(proj, "d"), { recursive: true });
  write("a/one.txt", "a (half done by claude)\n");
  write("b/one.txt", "b\n");
  write("stray.txt", "nobody's\n");
  await sleep(Math.max(0, 17_500 - (Date.now() - rungAtBusy))); // cross the 12 s retry threshold and the next 5 s sweep
  s = await state();
  const busyMember = s.agents.find((a: any) => a.id === "codex");
  const busyRing = s.mail.find((m: any) => m.id === queuedDuringT2.json.id);
  check(busyMember.waitingForTurn === 1 && busyMember.unansweredMail === 0 && busyMember.stuckMail === 0 &&
    s.attention?.agent !== "codex" && busyRing?.waitingForTurn && busyRing.status === "rung" && busyRing.ring_count === 1,
    "busy ring stays queued through the sweep, with neither retries nor a wake alert");
  check(!inboxItem(s, "delivery", "codex") && model.receiptLabel(s.chat.find((m: any) => m.text === "结束 T2 后再看").receipts[0])[0] === "排队中，等它这一轮结束",
    "busy chat stays out of the human inbox and retains its queue receipt");
  {
    const tl = (await state()).timeline as any[];
    const rounds = tl.filter((x) => x.type === "round" && x.meeting_id === mid);
    check(rounds.length >= 3 && rounds.at(-1).doc_path && rounds[0].turns.length === 2, "timeline has one card per meeting round, the last with the minutes path");
    check(tl.some((x) => x.type === "sys" && x.cat === "task"), "timeline has task events");
    check(!tl.some((x) => x.type === "sys" && /发言$/.test(x.text)), "turn events are folded into round cards");
    check(tl.every((x, i) => i === 0 || tl[i - 1].at <= x.at), "timeline is in time order");
  }
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "b 完成", files_changed: ["b/one.txt"] });
  const t2files = sh("show", "--name-only", "--format=", sub.commit).split("\n").filter(Boolean);
  check(t2files.length === 1 && t2files[0] === "b/one.txt", `parallel commit holds only the task's files (${t2files.join(",")})`);
  const preexistingNote = sub.scope_notes.find((n: string) => n.startsWith("开工前就有的未提交改动"));
  const parallelNote = sub.scope_notes.find((n: string) => n.startsWith("其他任务进行中的改动"));
  check(preexistingNote?.includes("IMPORTANT.md") && preexistingNote.includes("开工前新增.txt") && !preexistingNote.includes("a/one.txt"), "scope notes separate the staged and untracked changes present at task start");
  check(parallelNote?.includes("a/one.txt（claude/T1）") && !parallelNote.includes("IMPORTANT.md"), "scope notes identify the other active task by its lease");
  check(sub.scope_notes.some((n: string) => n.includes("stray.txt") && n.startsWith("改动不在本任务范围")), "an unleased new file still gets a generic scope note");
  check(sh("status", "--porcelain", "-uall").includes("a/one.txt"), "claude's in-flight file still uncommitted");
  fs.rmSync(path.join(proj, "stray.txt"));
  s = await state();
  check(tk("T2").status === "done" && tk("T3").status === "pending" && tk("T3").waiting === "等 T1", "T2 done (no reviewer), T3 still waits for T1");

  check(!(s.mail.find((m: any) => m.id === queuedDuringT2.json.id)?.waitingForTurn), "queue label clears when the active task stage ends");
  const afterBusy = await call(codex, "fetch_inbox", { agent_id: "codex" });
  check(afterBusy.mails.some((m: any) => m.id === queuedDuringT2.json.id), "codex can fetch the waiting mail after handing off T2");
  await call(codex, "ack", { agent_id: "codex", mail_ids: [queuedDuringT2.json.id] });
  t = task(afterBusy);
  check(t?.task?.key === "T4", "codex free → T4 delivered");
  write("a/one.txt", "a\n");
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "a 完成", files_changed: ["a/one.txt"] });
  check(sub.next === "codex/review", "T1 implement → review by codex");
  s = await state();
  const reviewAttempt = s.lives.find((x: any) => x.stage_id === "review");
  check(reviewAttempt && !s.mail.some((m: any) => m.kind === "task" && m.to === "codex" && m.status === "queued"), "review of T1 held while codex works on T4");
  write("d/one.txt", "d\n");
  await call(codex, "submit_handoff", { agent_id: "codex", summary: "d 完成", files_changed: ["d/one.txt"] });
  t = task(await call(codex, "fetch_inbox", { agent_id: "codex" }));
  check(t?.task?.key === "T1" && t.stage.id === "review" && t.input_handoff?.summary === "a 完成", "codex then gets the T1 review");
  check(t.stage.instructions.includes("verdict") && !t.instructions.includes("verdict 填 approve") && t.instructions.includes("task.paths") &&
    !t.instructions.includes(t.task.paths[0]) && t.instructions.includes("meeting_minutes") && !t.instructions.includes(t.meeting_minutes),
    "task instructions point at task.paths, meeting_minutes and the stage's own review rule instead of copying them");
  write("a/one.txt", "a (local change left in the review scope)\n");
  sub = await call(codex, "submit_handoff", { agent_id: "codex", summary: "a 没问题", verdict: "approve", files_changed: [] });
  check(/^[0-9a-f]{40}$/.test(sub.commit) && sh("diff-tree", "-r", "--no-commit-id", "--name-only", sub.commit) === "", "last active task's review commits an empty tree diff");
  check(sh("diff", "--cached", "--name-only") === "IMPORTANT.md" && sh("diff", "--name-only") === "a/one.txt", "empty review preserves both a staged user file and an unstaged file in its task scope");
  s = await state();
  const gate = s.lives.find((x: any) => x.status === "awaiting_approval");
  await api(`/api/attempts/${gate.id}/decide`, { action: "approve", note: "" });
  s = await state();
  check(tk("T1").status === "done" && tk("T3").status === "active", "T1 approved → T3 starts");
  check(!s.leases.some((l: any) => l.task === "T1" || l.task === "T2"), "finished tasks' leases released");
  t = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
  check(t?.task?.key === "T3" && t.dependencies.length === 2 && t.dependencies.every((d: any) => d.status === "done" && d.commit), "T3 sees its dependencies' results");

  // A replayed task letter reads the current dependency state, even when a dependency is unfinished.
  // This fixture changes only the temporary DB, since normal scheduling waits for T1 before dispatching T3.
  const dependencyDb = new DatabaseSync(path.join(proj, ".bridge", "bridge.db"));
  dependencyDb.exec("PRAGMA busy_timeout = 1000");
  const taskStatus = dependencyDb.prepare("UPDATE tasks SET status = ? WHERE id = ?");
  const attemptStatus = dependencyDb.prepare("UPDATE attempts SET status = ? WHERE id = ?");
  const upstreamId = tk("T1").id;
  try {
    taskStatus.run("active", upstreamId);
    attemptStatus.run("awaiting_approval", gate.id);
    await call(claude, "join", { agent_id: "claude" });
    const resumedTask = task(await call(claude, "fetch_inbox", { agent_id: "claude" }));
    const dependency = resumedTask?.dependencies.find((d: any) => d.key === "T1");
    check(resumedTask?.resumed && dependency?.status === "active" && dependency.stage === "review" &&
      dependency.stage_status === "awaiting_approval" && dependency.last_handoff_stage === "review" && dependency.commit === sub.commit,
      "replayed task mail includes the unfinished dependency's current stage and latest handoff commit");
  } finally {
    attemptStatus.run("approved", gate.id);
    taskStatus.run("done", upstreamId);
    dependencyDb.close();
  }
  write("c.txt", "c\n");
  sub = await call(claude, "submit_handoff", { agent_id: "claude", summary: "合并完成" });
  check(/^[0-9a-f]{40}$/.test(sub.commit) && sh("diff-tree", "-r", "--no-commit-id", "--name-only", sub.commit) === "c.txt", "last active implementation commits only its task paths");
  check(sub.scope_notes.some((n: string) => n.startsWith("开工前就有的未提交改动") && n.includes("a/one.txt")), "a dependent task gets a fresh baseline when its dependencies finish");
  check(sh("diff", "--cached", "--name-only") === "IMPORTANT.md" && sh("diff", "--name-only") === "a/one.txt", "scoped implementation leaves unrelated staged and unstaged changes intact");
  s = await state();
  check(s.run.status === "done" && s.tasks.every((x: any) => x.status === "done"), "all tasks done → run done");
  check(sh("log", "--format=%s", "-1").includes("T3"), "multi-task commits are labelled with the task key");

  {
    const tl = (await state()).timeline as any[];
    check(tl.some((x) => x.type === "handoff" && x.task?.key && x.data.summary), "timeline has handoff cards labelled with their task");
  }

  // ===== B: stdio proxy as the Claude doorbell =====
  console.log("— B: stdio proxy → fake Claude messaging pipe");
  const pipePath = `\\\\.\\pipe\\bridge-smoke-${randomUUID()}`;
  const frames: any[] = [];
  const pipe = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => pipe.listen(pipePath, r));
  async function connectClaudeProxy(socket = pipePath) {
    const proxy = new Client({ name: "fake-claude", version: "0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "bin/bridge-mcp.mjs")],
      env: { ...(process.env as Record<string, string>), BRIDGE_URL: BASE, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: "tok-123" },
    });
    await proxy.connect(transport);
    return { proxy, transport };
  }
  let { proxy, transport: claudeProxyTransport } = await connectClaudeProxy();
  const tools = await proxy.listTools();
  check(tools.tools.some((x) => x.name === "fetch_inbox"), "proxy lists daemon tools");
  const pj = await call(proxy as Client, "join", { agent_id: "pbot" });
  check(pj.doorbell === "claude-socket", "join through proxy registers the claude-socket doorbell");
  const socketReport = (await state()).agents.find((a: any) => a.id === "pbot").product;
  check(socketReport?.id === "claude-code" && socketReport.claudeSocket?.present && socketReport.claudeSocket.pipe !== false,
    "Claude socket hint identifies the product and reports pipe presence without probing it by writing");
  await sleep(500);
  check((await state()).agents.find((a: any) => a.id === "pbot").doorbellArmed, "doorbell armed (proxy long-polling)");
  await api("/api/mail", { to: "pbot", text: "该干活了" });
  for (let i = 0; i < 40 && frames.length < 2; i++) await sleep(100);
  check(frames[0]?.type === "auth" && frames[0].token === "tok-123", "proxy authenticates on the messaging pipe");
  check(frames[1]?.type === "user" && /\[协作桥\].*fetch_inbox/.test(frames[1].message.content), "proxy injects a [协作桥] wake-up message");
  await sleep(300);
  check((await state()).mail.find((m: any) => m.to === "pbot").status === "rung", "mail marked rung");
  const pi = await call(proxy as Client, "fetch_inbox", { agent_id: "pbot" });
  check(pi.mails[0]?.chat?.text.includes("该干活了"), "agent fetches the mail through the proxy");
  const firstBinding = (await state()).agents.find((a: any) => a.id === "pbot").binding?.session;
  const alias = await connectClaudeProxy(pipePath + "-other");
  check((await call(alias.proxy, "fetch_inbox", { agent_id: "pbot" })).error &&
    (await state()).agents.find((a: any) => a.id === "pbot").binding?.session === firstBinding, "another socket neither loads this join cache nor takes over its binding");
  await alias.proxy.close();
  await proxy.close();
  check(!(await state()).agents.find((a: any) => a.id === "pbot").binding, "closing proxy stdin deletes its MCP session and releases its identity");

  async function waitForProxyBinding() {
    for (let i = 0; i < 60; i++) {
      const agent = (await state()).agents.find((a: any) => a.id === "pbot");
      if (agent.binding && agent.doorbellArmed) return agent.binding.session as string;
      await sleep(100);
    }
    return null;
  }
  async function checkProxyDelivery(client: Client, message: string) {
    const before = frames.length;
    const sent = await api("/api/mail", { to: "pbot", text: message });
    for (let i = 0; i < 40 && frames.length < before + 2; i++) await sleep(100);
    const inbox = await call(client, "fetch_inbox", { agent_id: "pbot" });
    check(
      frames[before + 1]?.message.content.includes(message) && inbox.mails?.some((m: any) => m.id === sent.json.id),
      "restored proxy rings and fetches: " + message,
    );
  }
  ({ proxy, transport: claudeProxyTransport } = await connectClaudeProxy());
  const beforeCrash = await waitForProxyBinding();
  check(beforeCrash, "restarted Claude proxy replays join and arms before its first tool call");
  await checkProxyDelivery(proxy, "正常重启后的首封信");
  const closed = new Promise<void>((resolve) => { proxy.onclose = resolve; });
  process.kill(claudeProxyTransport.pid!, "SIGKILL");
  await closed;
  check((await state()).agents.find((a: any) => a.id === "pbot").binding?.session === beforeCrash, "killed proxy leaves the old HTTP binding behind");
  ({ proxy } = await connectClaudeProxy());
  for (let i = 0; i < 60 && (await state()).agents.find((a: any) => a.id === "pbot").binding?.session === beforeCrash; i++) await sleep(100);
  const afterCrash = await waitForProxyBinding();
  check(afterCrash && afterCrash !== beforeCrash, "same Claude socket takes over the orphaned binding");
  await checkProxyDelivery(proxy, "强制结束转接后的首封信");
  await stopDaemon();
  await startDaemon();
  check(await waitForProxyBinding(), "idle proxy restores its binding and doorbell after daemon restart");
  await checkProxyDelivery(proxy, "守护进程重启后的首封信");

  // Run #6: Claude desktop shut the idle conversation down (proxy gone), then reopened it with a NEW messaging
  // socket, so there is no join cache to replay. Mail meanwhile → the human is told soon; the first tool call
  // recovers the identity and the proxy gets its doorbell back.
  await proxy.close();
  const away = await api("/api/mail", { to: "pbot", text: "对话关着时来的信" });
  for (let i = 0; i < 80 && !(await state()).agents.find((a: any) => a.id === "pbot").unansweredMail; i++) await sleep(100);
  s = await state();
  check(
    s.agents.find((a: any) => a.id === "pbot").unansweredMail === 1 && s.attention?.agent === "pbot" && s.mail.find((m: any) => m.id === away.json.id)?.status === "queued",
    "mail for a closed conversation alerts the human within seconds and stays queued",
  );
  const pipe2Path = `\\\\.\\pipe\\bridge-smoke-${randomUUID()}`;
  const frames2: any[] = [];
  const pipe2 = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        frames2.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
  });
  await new Promise<void>((r) => pipe2.listen(pipe2Path, r));
  ({ proxy } = await connectClaudeProxy(pipe2Path));
  const reopened = await call(proxy, "fetch_inbox", { agent_id: "pbot" });
  check(reopened.identity_recovered && reopened.doorbell === "claude-socket" && /不需要轮询/.test(reopened.identity_note) && !/wait_for_mail/.test(reopened.instructions) && reopened.mails.some((m: any) => m.id === away.json.id),
    "first tool call from the reopened conversation recovers the identity with the claude-socket doorbell");
  check(await waitForProxyBinding(), "the proxy re-arms the doorbell after a recovery on a plain tool call");
  const after = await api("/api/mail", { to: "pbot", text: "恢复之后的信" });
  for (let i = 0; i < 40 && frames2.length < 2; i++) await sleep(100);
  check(frames2[1]?.message?.content.includes("[协作桥]") && (await call(proxy, "fetch_inbox", { agent_id: "pbot" })).mails.some((m: any) => m.id === after.json.id),
    "the reopened conversation is woken through its new socket");
  pipe2.close();

  await api("/api/agents/pbot/release", {});
  await proxy.close();
  ({ proxy } = await connectClaudeProxy());
  check((await call(proxy, "fetch_inbox", { agent_id: "pbot" })).error && !(await state()).agents.find((a: any) => a.id === "pbot").binding, "panel release revokes the cached replay");
  await call(proxy, "join", { agent_id: "pbot" });
  check((await call(proxy, "leave", { agent_id: "pbot" })).ok, "Claude proxy leaves deliberately");
  await proxy.close();
  ({ proxy } = await connectClaudeProxy());
  check((await call(proxy, "fetch_inbox", { agent_id: "pbot" })).error, "leave removes the Claude proxy's restore state");
  await proxy.close();
  pipe.close();

  // Codex uses the same stdio proxy without the Claude socket. A fresh proxy must join without takeover.
  const proxyEnv = { ...process.env, BRIDGE_URL: BASE } as Record<string, string>;
  delete proxyEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete proxyEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  for (const name of ["fake-codex", "restarted-codex"]) {
    const client = new Client({ name, version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "bin/bridge-mcp.mjs")], env: proxyEnv }));
    try {
      check((await call(client, "join", { agent_id: "pbot" })).agent_id === "pbot", `${name} joins without takeover`);
    } finally {
      await client.close();
    }
  }

  // ===== C: Codex Stop hook as the doorbell =====
  console.log("— C: Codex Stop hook");
  const tx = path.join(proj, "rollout.jsonl");
  const joinLine = (agent: string) =>
    JSON.stringify({
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "McpToolCall", server: "bridge", tool: "join", status: "completed", arguments: { agent_id: agent }, result: { content: [{ type: "text", text: JSON.stringify({ agent_id: agent, doorbell: "codex-hook" }) }] } } },
    });
  fs.writeFileSync(path.join(proj, "plain.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "user_message" } }) + "\n");
  let h = await runHook({ session_id: "s-plain", transcript_path: path.join(proj, "plain.jsonl") }, { BRIDGE_PARK_SECONDS: "20" });
  check(h.out === "{}" && h.ms < 3000, `thread that never joined is released immediately (${h.ms} ms)`);

  fs.writeFileSync(tx, joinLine("hbot") + "\n");
  const hookInput = { session_id: "s-1", transcript_path: tx, turn_id: "t-1", stop_hook_active: true, last_assistant_message: "待命", future_field: { value: 42 } };
  const parked = runHook(hookInput, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(1500);
  s = await state();
  check(s.agents.find((a: any) => a.id === "hbot").doorbellArmed && s.endpoints.some((x: any) => x.agent === "hbot" && x.address === "s-1"), "joined thread parks and registers");
  const rangAt = Date.now();
  const ringMail = await api("/api/mail", { to: "hbot", text: "新任务" });
  h = await parked;
  const hj = JSON.parse(h.out);
  const wakeLatency = Date.now() - rangAt;
  check(hj.decision === "block" && /fetch_inbox/.test(hj.reason) && wakeLatency < 5000, `mail → block with wake-up reason (${wakeLatency} ms after sending)`);
  const trace = fs.readFileSync(hookLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const stdinEntry = trace.find((entry) => entry.event === "stdin" && entry.stdin.session_id === hookInput.session_id);
  const hookEvents = trace.filter((entry) => entry.pid === stdinEntry?.pid);
  const outputEntry = hookEvents.find((entry) => entry.event === "output");
  check(JSON.stringify(stdinEntry?.stdin) === JSON.stringify(hookInput), "hook logs all stdin fields, including stop_hook_active, turn_id and unknown fields");
  check(outputEntry?.cause === "ring" && outputEntry.mailIds.includes(ringMail.json.id) && outputEntry.parked_ms > 0 && JSON.stringify(outputEntry.output) === h.out && hookEvents.some((entry) => entry.event === "stdout_complete" && entry.error === null), "hook log correlates parking duration and flushed stdout with the rung mail");

  const tx2 = path.join(proj, "rollout2.jsonl");
  fs.writeFileSync(tx2, joinLine("hbot2") + "\n");
  const fetching = await connect("fetching-codex");
  await call(fetching, "join", { agent_id: "hbot2" });
  const healthy = runHook({ session_id: "s-healthy", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(700);
  const healthyMail = await api("/api/mail", { to: "hbot2", text: "按铃后马上取信" });
  check(JSON.parse((await healthy).out).decision === "block", "second Codex hook receives its ring");
  check((await call(fetching, "fetch_inbox", { agent_id: "hbot2" })).mails.some((m: any) => m.id === healthyMail.json.id), "healthy Codex fetches its rung mail");

  for (let i = 0; i < 100 && Date.now() - rangAt < 10_500; i++) {
    s = await state();
    if (s.attention?.agent === "hbot") break;
    await sleep(100);
  }
  check(s.attention?.agent === "hbot" && s.attention.message.includes("叫不醒") && s.mail.find((m: any) => m.id === ringMail.json.id)?.status === "rung", `unfetched hook ring triggers a panel warning before sweep (${Date.now() - rangAt} ms)`);
  const manual = await connect("manual-codex");
  await call(manual, "join", { agent_id: "hbot" });
  check((await call(manual, "fetch_inbox", { agent_id: "hbot" })).mails.some((m: any) => m.id === ringMail.json.id), "manual recovery can still fetch the pending mail");
  await sleep(2000); // the healthy ring's own wake-up grace will have expired too
  s = await state();
  check(!s.attention && s.events.filter((e: any) => e.kind === "doorbell" && e.text.includes("仍有")).length === 1, "fetch clears the alert and a timely fetch never triggers one");
  // Woken and working (any tool call after the ring) but slow to fetch: no alert.
  const busyHook = runHook({ session_id: "s-busy", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "20" });
  await sleep(700);
  const busyMail = await api("/api/mail", { to: "hbot2", text: "醒了但先想一会儿" });
  check(JSON.parse((await busyHook).out).decision === "block", "busy Codex hook receives its ring");
  await sleep(1000);
  await call(fetching, "get_context", { agent_id: "hbot2" });
  await sleep(6500);
  s = await state();
  check(!s.attention && !s.events.some((e: any) => e.kind === "doorbell" && e.agent === "hbot2" && e.text.includes("仍有")), "a tool call after the ring suppresses the wake alert");
  await call(fetching, "fetch_inbox", { agent_id: "hbot2" });
  check(s.mail.find((m: any) => m.id === busyMail.json.id)?.status === "rung", "slow mail was still waiting, not re-rung away");
  const deliveryTrace = fs.readFileSync(path.join(proj, ".bridge", "bridge-log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  check([ringMail.json.id, healthyMail.json.id].every((id) => deliveryTrace.some((entry) => entry.event === "rung_mail_fetched" && entry.id === id)), "bridge log correlates both fetches with their ring and hook output by mail ID");

  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2" });
  check(JSON.parse(h.out).reason?.includes("心跳"), "quiet park window → heartbeat block");
  h = await runHook({ session_id: "s-2", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "2", BRIDGE_HEARTBEAT: "0" });
  check(h.out === "{}", "heartbeat off → let Codex stop");

  // Nobody parked: the mail must not sit silently — after ring_retry_seconds it becomes "stuck".
  await api("/api/mail", { to: "hbot3", text: "没人在等" });
  await sleep(17_000);
  s = await state();
  check(s.mail.find((m: any) => m.to === "hbot3")?.status === "stuck" && s.agents.find((a: any) => a.id === "hbot3").stuckMail === 1, "undeliverable mail → stuck + attention banner");
  const deliveryItem = inboxItem(s, "delivery", "hbot3");
  const deliveryCard = inboxContext(s, deliveryItem);
  check(deliveryCard?.agent === "hbot3" && deliveryCard.message === s.attention?.message &&
    deliveryItem.target.view === "office" && deliveryItem.target.anchor === "member-hbot3" &&
    s.inbox.filter((it: any) => it.kind === "delivery" && it.agent === "hbot3").length === 1, "inbox delivery, timeline and legacy fallback share the same evidence");
  const unreachable = activity(s, "hbot3");
  check(unreachable?.state === "unreachable" && unreachable.evidence && unreachable.since === deliveryItem?.at, "a stuck mail takes precedence over presence in Office");

  // Bridge restart while Codex is parked: the hook rides it out and still delivers.
  const survivor = runHook({ session_id: "s-3", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "60", BRIDGE_DOWN_GRACE_SECONDS: "30" });
  await sleep(1500);
  await stopDaemon();
  await sleep(3000);
  await startDaemon();
  await sleep(4000); // hook retries every 2 s
  check((await state()).agents.find((a: any) => a.id === "hbot2").doorbellArmed, "parked hook re-armed after bridge restart");
  await api("/api/mail", { to: "hbot2", text: "重启后的信" });
  h = await survivor;
  check(JSON.parse(h.out).decision === "block", "mail after restart still wakes the parked Codex");

  // Bridge gone for good: after the grace period the hook lets Codex stop.
  const orphan = runHook({ session_id: "s-4", transcript_path: tx2 }, { BRIDGE_PARK_SECONDS: "60", BRIDGE_DOWN_GRACE_SECONDS: "3" });
  await sleep(1500);
  await stopDaemon();
  h = await orphan;
  check(h.out === "{}" && h.ms < 15000, `bridge gone for good → Codex released after grace (${h.ms} ms)`);
  await startDaemon();

  // ===== E: codex-queue doorbell =====
  console.log("— E: codex-queue doorbell (fake codex CLI)");
  const queueStats = (snapshot: any) => snapshot.agents.find((a: any) => a.id === "qbot").doorbellStats.find((d: any) => d.kind === "codex-queue");
  const qbot = await connect("qbot");
  const qj = await call(qbot, "join", { agent_id: "qbot" });
  check(qj.doorbell === "codex-queue" && qj.protocol.some((l: string) => l.includes("正常结束本回合")), "product codex joins with the codex-queue doorbell");
  const early = await api("/api/mail", { to: "qbot", text: "对话还没登记时来的信" });
  await sleep(300);
  check((await state()).mail.find((m: any) => m.id === early.json.id)?.status === "queued" && codexCalls().length === 0, "before the hook registers the thread, mail waits (nothing to queue to)");
  const qtx = path.join(proj, "rollout-q.jsonl");
  fs.writeFileSync(qtx, joinLine("qbot") + "\n");
  h = await runHook({ session_id: "thread-q1", turn_id: "t1", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  check(h.out === "{}" && h.ms < 5000, `hook registers the thread and does not park (${h.ms} ms)`);
  for (let i = 0; i < 30 && codexCalls().length < 1; i++) await sleep(100);
  let calls = codexCalls();
  check(
    calls.length === 1 && calls[0][0] === "queue" && calls[0][calls[0].indexOf("--thread") + 1] === "thread-q1" && /\[协作桥\].*fetch_inbox/.test(calls[0][calls[0].indexOf("--message") + 1]),
    "registration rings the waiting mail via `codex queue --thread <id> --message …`",
  );
  s = await state();
  check(s.mail.find((m: any) => m.id === early.json.id)?.status === "rung" && s.agents.find((a: any) => a.id === "qbot").doorbellArmed, "mail rung, codex-queue doorbell armed");
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });

  // Codex already has a wake message queued for this thread → don't stack another.
  const qdb = new DatabaseSync(path.join(codexHome, "queue_1.sqlite"));
  qdb.exec("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)");
  qdb.prepare("INSERT INTO queued_items VALUES ('x', 'thread-q1', '{}', 1, 0, 0)").run();
  const dup = await api("/api/mail", { to: "qbot", text: "队列里已有叫醒消息" });
  await sleep(800);
  check(codexCalls().length === 1 && (await state()).mail.find((m: any) => m.id === dup.json.id)?.status === "rung", "a wake already waiting in Codex's queue is not stacked");
  qdb.exec("DELETE FROM queued_items");
  qdb.close();
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });

  // Run #6: two mails seconds apart → the second ring lands while `codex queue` is still running → one wake.
  const burstBefore = codexCalls().length;
  await Promise.all([api("/api/mail", { to: "qbot", text: "连发 1" }), api("/api/mail", { to: "qbot", text: "连发 2" })]);
  await sleep(1500);
  check(codexCalls().length === burstBefore + 1, "mails in quick succession queue a single Codex wake");
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });

  // Rung, but no tool call within the grace → the human is told (no other doorbell is available).
  const silentBefore = codexCalls().length;
  const silent = await api("/api/mail", { to: "qbot", text: "没人理的信" });
  await sleep(7500);
  s = await state();
  check(
    codexCalls().length === silentBefore + 1 && s.agents.find((a: any) => a.id === "qbot").unansweredMail === 1 && s.events.some((e: any) => e.agent === "qbot" && e.text.includes("仍有")),
    "no sign of life after a codex-queue ring → alert",
  );
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });
  check((await state()).agents.find((a: any) => a.id === "qbot").unansweredMail === 0, "fetching clears the alert");

  // `codex queue` fails → mail goes back, the human is told at once, and the next Stop hook parks as fallback.
  fs.writeFileSync(path.join(codexHome, "fail"), "");
  const broken = await api("/api/mail", { to: "qbot", text: "codex queue 坏了" });
  for (let i = 0; i < 30; i++) {
    s = await state();
    if (s.agents.find((a: any) => a.id === "qbot").doorbellError) break;
    await sleep(100);
  }
  const qa = s.agents.find((a: any) => a.id === "qbot");
  check(
    qa.doorbellError?.includes("boom") && s.mail.find((m: any) => m.id === broken.json.id)?.status === "queued" && qa.unansweredMail === 1,
    "failed codex queue → mail requeued, error shown, human alerted immediately",
  );
  const mixedWakeStats = queueStats(s);
  check(mixedWakeStats.consecutiveFailures === 2 && mixedWakeStats.unconfirmedInStreak === 1 && mixedWakeStats.ringFailuresInStreak === 1 &&
    activity(s, "qbot")?.evidence.includes("连续 2 次唤醒异常（响铃失败 1 次，响铃后未确认 1 次）"),
    "a ring timeout and a command failure belong to the same streak and are reported separately");
  fs.rmSync(path.join(codexHome, "fail"));
  const fallback = runHook({ session_id: "thread-q1", turn_id: "t2", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  h = await fallback;
  check(JSON.parse(h.out).decision === "block" && JSON.parse(h.out).reason.includes("fetch_inbox"), "after a queue failure the hook parks again and delivers the mail itself");
  await call(qbot, "fetch_inbox", { agent_id: "qbot" });
  const qtrace = fs.readFileSync(path.join(proj, ".bridge", "bridge-log.jsonl"), "utf8");
  check(qtrace.includes('"event":"codex_queue"') && qtrace.includes('"via":"codex-queue"'), "bridge log records codex queue calls and rings by doorbell");

  // Bridge restart: the registered thread predates this daemon and qbot hasn't re-joined (the user may have
  // opened a new conversation) → don't wake the old one; wait for the Stop hook to register again.
  await stopDaemon();
  await startDaemon();
  const before = codexCalls().length;
  const afterRestart = await api("/api/mail", { to: "qbot", text: "重启后、还没重新加入时来的信" });
  await sleep(800);
  check(codexCalls().length === before && (await state()).mail.find((m: any) => m.id === afterRestart.json.id)?.status === "queued", "after a restart, a thread registered before it is not woken");
  h = await runHook({ session_id: "thread-q2", turn_id: "t1", stop_hook_active: false, transcript_path: qtx }, { BRIDGE_PARK_SECONDS: "20" });
  for (let i = 0; i < 30 && codexCalls().length === before; i++) await sleep(100);
  calls = codexCalls();
  check(h.out === "{}" && calls.length === before + 1 && calls.at(-1)![calls.at(-1)!.indexOf("--thread") + 1] === "thread-q2", "a fresh registration after the restart is woken");

  // ===== F: P2 diagnostics and bounded cooldown =====
  console.log("— F: isolated CLI, version refresh, format drift and cooldown");
  await stopDaemon();
  const offlineProxy = await connectProxy("codex-mcp-client");
  let offlineError = "";
  try { await offlineProxy.listPrompts(undefined, { timeout: 5_000 }); }
  catch (e) { offlineError = String(e); }
  await offlineProxy.close();
  check(offlineError.includes("无法从协作桥读取提示词") && offlineError.includes("守护进程"), "stdio explains why prompts cannot be read when the daemon is offline");

  const diagnosticProject = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-diagnostics-"));
  execFileSync("git", ["-C", diagnosticProject, "init", "-q"]);
  fs.writeFileSync(path.join(diagnosticProject, "bridge.config.yaml"), `agents:
  qbot: { product: codex }
  codex_alt: { product: codex, doorbell: poll }
pipeline:
  - { id: implement, role: 实现, agent: qbot }
mail: { ring_retry_seconds: 600 }
doorbells: { cooldown_seconds: 4 }
notify: { enabled: false }
`);
  await startDaemon(diagnosticProject, "0.45", { BRIDGE_VERSION_REFRESH_SECONDS: "2", BRIDGE_VERSION_RETRY_SECONDS: "0.25" });
  const codexVersion = (snapshot: any, id = "qbot") => snapshot.agents.find((a: any) => a.id === id)?.product?.version;

  fs.writeFileSync(fakeVersionFile, "unknown");
  const probesBeforeFirstRead = versionProbes().length;
  s = await waitState(() => versionProbes().length > probesBeforeFirstRead, "initial version was not probed");
  check(codexVersion(s) === "unknown", "the initial product version is unknown until the first successful probe");
  fs.writeFileSync(fakeVersionFile, "9.1.2");
  s = await waitState((snapshot) => codexVersion(snapshot) === "9.1.2", "unknown version was not retried");
  check(codexVersion(s, "codex_alt") === "9.1.2", "members of the same product share the detected version");

  const probesBeforeRefresh = versionProbes().length;
  fs.writeFileSync(fakeVersionHold, "");
  fs.writeFileSync(fakeVersionFile, "fail");
  try {
    await waitState(() => versionProbes().at(-1) === "fail", "known version did not expire");
    const snapshots = await Promise.all(Array.from({ length: 5 }, () => state()));
    await sleep(300); // Allow any duplicate fake processes time to log that they started.
    check(versionProbes().length === probesBeforeRefresh + 1 && snapshots.every((snapshot) =>
      codexVersion(snapshot) === "9.1.2" && codexVersion(snapshot, "codex_alt") === "9.1.2"),
      "concurrent snapshots share one pending probe and return the cached version");
  } finally {
    fs.rmSync(fakeVersionHold);
  }
  s = await waitState(() => versionProbes().length >= probesBeforeRefresh + 2, "failed version probe was not retried");
  check(codexVersion(s) === "9.1.2", "a failed probe keeps the last known version through the retry");
  fs.writeFileSync(fakeVersionFile, "9.2.3");
  s = await waitState((snapshot) => codexVersion(snapshot) === "9.2.3", "refreshed version was not visible on the running daemon");
  check(codexVersion(s, "codex_alt") === "9.2.3", "install version changes become visible without restarting the daemon");

  const diagnosticCodex = await connectProxy("codex-mcp-client");
  const multiple = await call(diagnosticCodex, "join", {});
  check(multiple.error?.includes("多个成员") && multiple.candidates?.join(",") === "qbot,codex_alt",
    "implicit join returns just the product matches when more than one member matches");
  await call(diagnosticCodex, "join", { agent_id: "qbot" });

  async function fetchAfterQueueStarts<T>(trigger: () => T | Promise<T>) {
    const before = codexCalls().length;
    fs.writeFileSync(fakeQueueHold, "");
    try {
      const result = await trigger();
      const deadline = Date.now() + 10_000;
      while (codexCalls().length === before) {
        if (Date.now() >= deadline) throw new Error("expected a new fake Codex queue invocation");
        await sleep(20);
      }
      // The logged invocation is the simulated wake. Fetch before CLI exit so state-poll latency cannot use up the grace window.
      const { mails } = await call(diagnosticCodex, "fetch_inbox", { agent_id: "qbot" });
      return { result, mails };
    } finally {
      fs.rmSync(fakeQueueHold);
    }
  }

  const knownThread = "thread-diagnostics";
  h = await runHook({ session_id: knownThread, transcript_path: qtx }, {});
  check(h.out === "{}" && !(await state()).inbox.some((e: any) => e.kind === "diagnostic"),
    "a normal Stop transcript and queue schema produce no drift");

  await smokeCli(BASE, fakeCodex, check);
  for (let i = 1; i <= 2; i++) {
    await api("/api/mail", { to: "qbot", text: "模拟无人确认 " + i });
    s = await waitState((snapshot) => queueStats(snapshot).failed === i, "did not observe sequential wake timeout " + i);
    check(!queueStats(s).degradedUntil, "queue remains eligible after timeout " + i);
  }
  const cooldownHook = fetch(BASE + "/api/doorbell/wait?agent=qbot&kind=codex-hook&timeout=8").then((r) => r.json());
  // A direct parked hook is registered immediately; give the loopback request time to reach the daemon.
  await sleep(200);
  const third = await api("/api/mail", { to: "qbot", text: "第三次无人确认，改用 Stop hook" });
  const fallbackRing = await cooldownHook;
  s = await waitState((snapshot) => !!queueStats(snapshot).degradedUntil, "queue did not enter cooldown");
  check(fallbackRing.mailIds?.includes(third.json.id) && queueStats(s).rings === 3 && queueStats(s).failed === 3 &&
    queueStats(s).confirmed === 0 && queueStats(s).consecutiveFailures === 3 &&
    queueStats(s).unconfirmedInStreak === 3 && queueStats(s).ringFailuresInStreak === 0 &&
    s.events.filter((e: any) => e.kind === "doorbell_degraded").length === 1 &&
    activity(s, "qbot")?.evidence.includes("连续 3 次响铃后未确认"),
    "three unconfirmed rings degrade only the queue and fall through to the parked hook with the expected evidence");
  await call(diagnosticCodex, "fetch_inbox", { agent_id: "qbot" });
  s = await waitState((snapshot) => !queueStats(snapshot).degradedUntil, "queue did not recover after cooldown");
  check(queueStats(s).consecutiveFailures === 0 && queueStats(s).unconfirmedInStreak === 0 &&
    s.events.filter((e: any) => e.kind === "doorbell_recovered").length === 1,
    "one recovery event re-enables the queue and resets its failure streak");
  const { result: recoveredMail, mails: afterRecovery } = await fetchAfterQueueStarts(() =>
    api("/api/mail", { to: "qbot", text: "恢复后的信" }));
  check(afterRecovery.some((m: any) => m.id === recoveredMail.json.id),
    "the restored queue delivers a new wake");
  s = await waitState((snapshot) => queueStats(snapshot).confirmed === 1, "resumed ring was not confirmed by a tool call");
  check(queueStats(s).rings === 4 && queueStats(s).failed === 3 && !inboxItem(s, "diagnostic"),
    "wake statistics preserve confirmed and failed totals with a healthy format");

  fs.writeFileSync(path.join(codexHome, "fail"), "");
  const failedWakeMail = await api("/api/mail", { to: "qbot", text: "模拟队列命令报错" });
  s = await waitState((snapshot) => !!queueStats(snapshot).degradedUntil, "a single queue command failure did not trigger cooldown");
  const commandFailure = queueStats(s);
  check(commandFailure.consecutiveFailures === 1 && commandFailure.ringFailuresInStreak === 1 && commandFailure.unconfirmedInStreak === 0 &&
    activity(s, "qbot")?.evidence.includes("连续 1 次响铃失败"),
    "a command failure degrades immediately and is reported as a ring failure");
  const { mails: retriedMail } = await fetchAfterQueueStarts(() => fs.rmSync(path.join(codexHome, "fail")));
  s = await waitState((snapshot) => !queueStats(snapshot).degradedUntil && queueStats(snapshot).confirmed === 2,
    "retried wake was not confirmed after the queue recovered from a command failure");
  check(queueStats(s).rings === commandFailure.rings + 1 && queueStats(s).consecutiveFailures === 0 &&
    queueStats(s).ringFailuresInStreak === 0 && queueStats(s).failed === 4 &&
    retriedMail.some((m: any) => m.id === failedWakeMail.json.id),
    "cooldown recovery clears the ring-failure streak and confirms the retried wake");
  const ringsBeforeDrift = queueStats(s).rings;

  const driftTranscript = path.join(diagnosticProject, "rollout-changed.jsonl");
  fs.writeFileSync(driftTranscript, [
    { type: "session_meta", payload: { cli_version: "9.3.0" } },
    { payload: { item: { type: "RenamedMcpToolCall", server: "bridge", tool: "join", status: "completed" } } },
  ].map((line) => JSON.stringify(line)).join("\n"));
  const noRingBefore = codexCalls().length;
  h = await runHook({ session_id: knownThread, transcript_path: driftTranscript }, {});
  s = await state();
  const transcriptItem = inboxItem(s, "diagnostic", "qbot");
  check(h.out === "{}" && codexCalls().length === noRingBefore && transcriptItem?.urgency === "normal" &&
    inboxContext(s, transcriptItem)?.version === "9.3.0" && s.events.some((e: any) => e.kind === "drift" && e.text.includes("9.3.0")),
    "broken transcript reports a versioned diagnostic card and does not wake or register a thread");

  const changedDb = new DatabaseSync(path.join(codexHome, "queue_1.sqlite"));
  changedDb.exec("ALTER TABLE queued_items RENAME TO incompatible_items");
  changedDb.close();
  for (let i = 0; i < 2; i++) {
    await api("/api/mail", { to: "qbot", text: "格式变化时仍可用队列投递 " + i });
    await waitState((snapshot) => queueStats(snapshot).rings === ringsBeforeDrift + 1 + i, "schema drift interrupted queue fallback");
    await call(diagnosticCodex, "fetch_inbox", { agent_id: "qbot" });
  }
  s = await waitState((snapshot) => snapshot.timeline.some((it: any) => it.source === "codex-queue"), "no queue schema warning");
  check(s.inbox.filter((it: any) => it.kind === "diagnostic").length === 2 &&
    s.events.filter((e: any) => e.kind === "drift" && e.text.includes("队列数据库")).length === 1 &&
    s.agents.find((a: any) => a.id === "qbot").diagnostics.length === 2,
    "changed queue schema falls back to enqueue, with a single per-daemon drift event and member diagnostics");
  await diagnosticCodex.close();

  // ===== G: P3 delivery timing and listener startup =====
  console.log("— G: P3 ack, queue turn grace and occupied port");
  await stopDaemon();
  const queueDb = new DatabaseSync(path.join(codexHome, "queue_1.sqlite"));
  queueDb.exec("ALTER TABLE incompatible_items RENAME TO queued_items");
  queueDb.close();
  const timingProject = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-timing-"));
  execFileSync("git", ["-C", timingProject, "init", "-q"]);
  fs.writeFileSync(path.join(timingProject, "bridge.config.yaml"), `agents: { qbot: { product: codex }, other: { doorbell: poll } }
pipeline:
  - { id: implement, role: 编码, agent: qbot }
  - { id: review, role: 审查, agent: qbot, gate: true }
git: { auto_commit: false }
mail: { ring_retry_seconds: 1, max_rings: 1, ack_timeout_seconds: 2 }
notify: { enabled: false }
`);
  await startDaemon(timingProject, "0.45", { BRIDGE_WAKE_TURN_EXTRA_SECONDS: "9" });
  const collisionProject = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-port-"));
  const collision = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "start", collisionProject, "--port", String(PORT)], {
    encoding: "utf8", timeout: 8000, windowsHide: true, env: { ...process.env, BRIDGE_NOTIFY: "0" },
  });
  check(collision.status === 1 && collision.stderr.includes("EADDRINUSE") && collision.stderr.includes(timingProject) &&
    collision.stderr.includes("--port") && !collision.stdout.includes("面板:") && !fs.existsSync(path.join(collisionProject, ".bridge")) &&
    (await state()).project === timingProject, "CLI fails on an occupied port and names the running project without opening the new database");

  const timing = await connect("timing-qbot");
  const other = await connect("timing-other");
  await call(timing, "join", { agent_id: "qbot" });
  await call(other, "join", { agent_id: "other" });
  await call(other, "send_mail", { agent_id: "other", to: "qbot", subject: "确认信", body: "请确认", ack_required: true });
  const timingRun = await api("/api/runs", { goal: "回合结束后再投递审查" });
  const letters = (await call(timing, "fetch_inbox", { agent_id: "qbot" })).mails;
  const inProgressMail = letters.find((m: any) => m.kind === "task").id;
  const normalMail = letters.find((m: any) => m.kind === "agent").id;
  const overdue = (snapshot: any, id: string) => snapshot.mail.find((mail: any) => mail.id === id)?.overdue;
  const until = Date.now() + 9500;
  do {
    await call(timing, "report_progress", { agent_id: "qbot", text: "仍在处理" });
    s = await state();
    if (overdue(s, normalMail)) break;
    await sleep(450);
  } while (Date.now() < until);
  check(overdue(s, normalMail) && overdue(s, inProgressMail) === false,
    "active task with recent progress avoids overdue while other acknowledged mail still flags");
  s = await waitState((snapshot) => overdue(snapshot, inProgressMail), "inactive fetched task was not flagged");
  check(overdue(s, inProgressMail), "an in-progress task with no recent tools eventually flags overdue");

  await api("/api/agents/qbot/endpoint", { kind: "codex-thread", address: "thread-timing" });
  const started = Date.now();
  await call(timing, "submit_handoff", { agent_id: "qbot", summary: "刚交接，当前回合还要结束" });
  await waitState((snapshot) => queueStats(snapshot).rings === 1, "next stage did not ring Codex queue");
  await sleep(Math.max(0, 5600 - (Date.now() - started)));
  s = await state();
  const queued = s.mail.find((m: any) => m.kind === "task" && m.id !== inProgressMail);
  check(queued?.status === "rung" && queued.ring_count === 1 && queueStats(s).failed === 0 && !inboxItem(s, "delivery", "qbot"),
    "deferred queue grace covers both the base timer and the retry sweep just after handoff");
  check(task(await call(timing, "fetch_inbox", { agent_id: "qbot" }))?.stage.id === "review", "Codex can take its queued review inside the extended grace");
  s = await waitState((snapshot) => queueStats(snapshot).confirmed === 1, "late fetch was not credited as a confirmed wake");
  check(queueStats(s).failed === 0 && s.now_playing[0].folder === "r" + timingRun.json.run_id && s.now_playing[0].stage_index === 1,
    "grace-window fetch is confirmed and exposes the real stage index");
  await timing.close();
  await other.close();

  // ===== H: wake confirmation by call sequence, on a frozen clock =====
  console.log("— H: same-millisecond wake confirmation");
  {
    process.env.BRIDGE_WAKE_GRACE_SECONDS = "0.05";
    const { Postman } = await import("../src/engine/postman.js");
    const { Presence } = await import("../src/engine/presence.js");
    delete process.env.BRIDGE_WAKE_GRACE_SECONDS;
    const realNow = Date.now;
    const frozen = realNow();
    const sameMs = async (label: string, mode: "before" | "after" | "takeover") => {
      const mails = new Map<string, { id: string; status: string; to_agent: string; subject: string }>();
      const results: string[] = [];
      const stub = <T extends object>(own: T) => new Proxy(own, { get: (t: any, k) => (k in t ? t[k] : () => undefined) });
      const store = stub({
        mailByStatus: (agent: string, statuses: string[]) => [...mails.values()].filter((m) => m.to_agent === agent && statuses.includes(m.status)),
        setMailStatus: (ids: string[], status: string) => { for (const id of ids) mails.get(id)!.status = status; },
        mail: (id: string) => mails.get(id),
      });
      const ctx = stub({ cfg: { agents: { q: {} }, wait: { poll_seconds: 1 }, mail: {} }, store, onChange() {}, log() {}, event() {}, notifyHuman() {} });
      const bell = { kind: "fake", label: "测试门铃", verify: true, waitsForTurn: false, ring: async () => ({ ok: true }) };
      const doorbells = stub({
        pick: (_agent: string, tried: Set<string>) => (tried.has("fake") ? undefined : bell),
        recordRing() {},
        recordResult: (_agent: string, _bell: unknown, result: string) => { results.push(result); },
      });
      const presence = new Presence(ctx as any, doorbells as any, { wakeWaiter() {}, resendLiveTask() {} });
      const postman = new Postman(ctx as any, presence, doorbells as any, { task: () => null, meeting: () => null, chat: () => null });
      Date.now = () => frozen;
      try {
        const p = presence.get("q")!;
        let oldWait: Promise<any> | undefined;
        if (mode === "takeover") {
          p.sessionId = "old-session";
          oldWait = postman.waitForMail("q", "old-session", new AbortController().signal);
          await sleep(0);
          p.sessionId = "new-session"; // another session joins as q …
        }
        presence.touch("q"); // … or the handoff call that queues the next stage for the same agent
        mails.set(label, { id: label, status: "queued", to_agent: "q", subject: label });
        postman.kick("q"); // also ends the old session's wait, after the ring
        await sleep(0);
        if (mode === "after") presence.touch("q"); // a new call in the very same millisecond
        const sameInstant = p.lastSeenAt === p.lastRingAt;
        const waitEnded = oldWait && (await oldWait);
        await sleep(200);
        return { result: results[0], sameInstant, status: mails.get(label)!.status, waitEnded };
      } finally {
        Date.now = realNow;
      }
    };
    const before = await sameMs("before", "before");
    check(before.sameInstant && before.result === "timeout" && before.status === "rung",
      "a call in the ring's millisecond that came before the ring does not confirm the wake");
    const after = await sameMs("after", "after");
    check(after.sameInstant && after.result === "confirmed",
      "a call in the ring's millisecond that came after the ring confirms the wake");
    const takeover = await sameMs("takeover", "takeover");
    check(takeover.sameInstant && String(takeover.waitEnded?.error).includes("接管") && takeover.result === "timeout" && takeover.status === "rung",
      "a taken-over session's wait ending after the ring does not confirm the wake");
  }

  // ===== I: minutes names through approval, and meeting events linked by id =====
  console.log("— I: minutes file names and events.meeting_id");
  await stopDaemon();
  const minutesProject = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-minutes-"));
  const mgit = (...args: string[]) => execFileSync("git", ["-C", minutesProject, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  mgit("init", "-q");
  mgit("config", "user.name", "bridge-smoke");
  mgit("config", "user.email", "bridge-smoke@example.invalid");
  fs.writeFileSync(path.join(minutesProject, "bridge.config.yaml"), `agents: { mbot: { doorbell: poll } }
pipeline:
  - { id: implement, role: 编码, agent: mbot }
notify: { enabled: false }
`);
  mgit("add", "-A");
  mgit("commit", "-qm", "init");
  await startDaemon(minutesProject);
  const mbot = await connect("minutes-mbot");
  await call(mbot, "join", { agent_id: "mbot" });
  const meet = async (topic: string) => {
    const started = await api("/api/meetings", { topic, participants: ["mbot"], facilitator: "mbot" });
    const id = started.json.meeting_id;
    await call(mbot, "fetch_inbox", { agent_id: "mbot" });
    await call(mbot, "submit_meeting_turn", { agent_id: "mbot", meeting_id: id, content: "提案" });
    await api(`/api/meetings/${id}/next`, { action: "finalize", note: "" });
    await call(mbot, "fetch_inbox", { agent_id: "mbot" });
    await call(mbot, "submit_meeting_turn", { agent_id: "mbot", meeting_id: id, content: "定稿", tasks: [{ id: "T1", title: "收尾", owner: "mbot" }] });
    const approved = await api(`/api/meetings/${id}/decide`, { action: "approve", note: "" });
    await api("/api/runs/stop", {});
    return { id, ...approved.json };
  };
  const day = new Date().toISOString().slice(0, 10);
  const committed = (sha: string) => mgit("-c", "core.quotepath=false", "show", "--name-only", "--format=", sha).trim().split("\n");
  const blank = await meet("「（）」：①②——");
  check(blank.doc_path === `doc/meetings/${day}-m${blank.id}.md` && committed(blank.commit).includes(blank.doc_path),
    "a topic with nothing left after cleaning gives minutes with no short title");
  const wide = "𠀀".repeat(30);
  const long = await meet("①“" + wide + "”，其余说明");
  check(long.doc_path === `doc/meetings/${day}-m${long.id}-${"𠀀".repeat(24)}.md` && committed(long.commit).includes(long.doc_path),
    "the short title keeps 24 characters even outside the BMP, without circled numbers or quotes");
  const versioned = await meet("收尾 0.9.0 的问题：细节");
  check(versioned.doc_path === `doc/meetings/${day}-m${versioned.id}-收尾-0.9.0-的问题.md`, "a version number's dots do not end the short title");
  const nextId = versioned.id + 1;
  const taken = [`doc/meetings/${day}-m${nextId}-重名.md`, `doc/meetings/${day}-m${nextId}-重名-2.md`];
  for (const [i, f] of taken.entries()) fs.writeFileSync(path.join(minutesProject, f), "已有内容 " + i);
  const clash = await meet("重名");
  check(clash.id === nextId && clash.doc_path === `doc/meetings/${day}-m${nextId}-重名-3.md` && committed(clash.commit).includes(clash.doc_path) &&
    taken.every((f, i) => fs.readFileSync(path.join(minutesProject, f), "utf8") === "已有内容 " + i),
    "minutes skip both taken names, land on -3 and leave the existing files alone");

  const folderEventsOf = async (id: string) => (await api(`/api/folders/${id}`)).json.events.map((e: any) => e.text);
  const linked = await folderEventsOf("m" + blank.id);
  check(linked.filter((t: string) => t.startsWith(`你批准了会议 #${blank.id} `)).length === 1 && linked.some((t: string) => t.startsWith("任务 #")) &&
    linked.some((t: string) => t.startsWith(`会议 #${blank.id} 开始`)), "a meeting folder lists its own events once, together with its run's events");
  const newFolders = (await api("/api/folders?limit=100")).json.folders.map((f: any) => f.id);
  const newEvents = await Promise.all(newFolders.map(folderEventsOf));
  await mbot.close();
  await stopDaemon();

  // Turn the database back into one from before events.meeting_id, plus legacy rows for meetings #1–#10.
  const legacy = new DatabaseSync(path.join(minutesProject, ".bridge", "bridge.db"));
  legacy.exec("DROP INDEX events_meeting; ALTER TABLE events DROP COLUMN meeting_id");
  const addMeeting = legacy.prepare(`INSERT INTO meetings (id, topic, participants, facilitator, status, round, round_kind, created_at)
    VALUES (?, ?, '["mbot"]', 'mbot', 'cancelled', 1, 'proposal', '2020-01-01T00:00:00.000Z')`);
  for (let id = nextId + 1; id <= 10; id++) addMeeting.run(id, "旧会议 " + id);
  const addEvent = legacy.prepare("INSERT INTO events (run_id, agent, kind, text, created_at) VALUES (NULL, ?, 'meeting', ?, ?)");
  const tie = "2031-01-01T00:00:00.000Z";
  addEvent.run(null, "会议 #10 开始：议题十（mbot，定稿：mbot）", "2030-01-01T00:00:00.000Z");
  addEvent.run("mbot", "mbot 在会议 #10 第 1 轮提案发言", tie);
  addEvent.run(null, "会议 #9 进入第 2 轮：互评（你的意见：参考会议 #1 的结论）", tie);
  addEvent.run(null, "自由文本提到会议 #8 但不是模板", "2032-01-01T00:00:00.000Z");
  addEvent.run("QA bot", "QA bot 在会议 #7 第 1 轮提案发言", "2029-01-01T00:00:00.000Z");
  addEvent.run("QA", "QA bot 在会议 #6 第 1 轮提案发言", "2029-01-02T00:00:00.000Z");
  // Make the first upgrade fail halfway through the backfill.
  legacy.exec(`CREATE TRIGGER stop_backfill BEFORE UPDATE OF meeting_id ON events BEGIN SELECT RAISE(ABORT, 'interrupted backfill'); END`);
  legacy.close();
  const interrupted = spawnSync(process.execPath, ["--import", "tsx", "src/daemon.ts", "--project", minutesProject, "--port", String(PORT)], {
    encoding: "utf8", timeout: 15000, windowsHide: true, env: { ...process.env, BRIDGE_NOTIFY: "0" },
  });
  const afterFailure = new DatabaseSync(path.join(minutesProject, ".bridge", "bridge.db"));
  const hasColumn = (afterFailure.prepare("PRAGMA table_info(events)").all() as { name: string }[]).some((c) => c.name === "meeting_id");
  afterFailure.exec("DROP TRIGGER stop_backfill");
  afterFailure.close();
  check(interrupted.status !== 0 && (interrupted.stderr + interrupted.stdout).includes("interrupted backfill") && !hasColumn,
    "an upgrade that fails during the backfill leaves no meeting_id column behind");
  await startDaemon(minutesProject);
  const reopenedFolders = (await api("/api/folders?limit=100")).json.folders;
  check(reopenedFolders[0].id === "m9" && reopenedFolders[1].id === "m10" && reopenedFolders[0].updated_at === tie && reopenedFolders[1].updated_at === tie,
    "backfilled meeting events order folders, the same time broken by folder id, and free text naming #8 is not linked");
  check(JSON.stringify((await Promise.all(newFolders.map(folderEventsOf)))) === JSON.stringify(newEvents) &&
    JSON.stringify(reopenedFolders.filter((f: any) => newFolders.includes(f.id)).map((f: any) => f.id)) === JSON.stringify(newFolders),
    "after reopening, the existing meetings keep their folder order and events");
  check((await folderEventsOf("m10")).length === 2 && (await folderEventsOf("m1")).every((t: string) => !t.includes("参考会议 #1")) &&
    (await folderEventsOf("m9")).length === 1, "legacy rows link to the meeting their template names: #10 is not #1, and a note naming #1 stays with #9");
  check((await folderEventsOf("m7")).includes("QA bot 在会议 #7 第 1 轮提案发言") && (await folderEventsOf("m6")).length === 0 &&
    reopenedFolders.find((f: any) => f.id === "m7")?.updated_at === "2029-01-01T00:00:00.000Z",
    "a speech by a member whose id has a space is linked by the row's agent, and a row from another agent is not");
  const paged: string[] = [];
  let cursor = "";
  do {
    const page = (await api("/api/folders?limit=1" + (cursor ? "&before=" + encodeURIComponent(cursor) : ""))).json;
    paged.push(...page.folders.map((f: any) => f.id));
    cursor = page.next_before;
  } while (cursor);
  check(JSON.stringify(paged) === JSON.stringify(reopenedFolders.map((f: any) => f.id)), "one-folder pages walk the whole list once across the tied timestamps");

  console.log("— J: proxy started while the daemon is down");
  // Codex reads a conversation's tool list once and ignores tools/list_changed, so a proxy that starts
  // while the daemon is down must still list the real tools (from its last good listing).
  const toolsFile = (dir: string, base: string) =>
    path.join(dir, "ai-bridge", `tools-${createHash("sha256").update(base).digest("hex").slice(0, 16)}.json`);
  const proxyIn = async (dir: string, base: string) => {
    const c = new Client({ name: "smoke-offline", version: "0.0.1" });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(ROOT, "bin/bridge-mcp.mjs")],
      env: { ...(process.env as Record<string, string>), BRIDGE_URL: base, TMP: dir, TEMP: dir, TMPDIR: dir },
    }));
    return c;
  };
  const deadPort = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); });
  });
  const deadBase = `http://127.0.0.1:${deadPort}`;
  const onlineDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-tools-"));
  const online = await proxyIn(onlineDir, BASE);
  const liveTools = (await online.listTools()).tools.map((t) => t.name);
  await online.close();
  const cache = JSON.parse(fs.readFileSync(toolsFile(onlineDir, BASE), "utf8"));
  check(liveTools.includes("join") && JSON.stringify(cache.tools.map((t: any) => t.name)) === JSON.stringify(liveTools),
    "a successful listing is cached per bridge address");

  const coldDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-tools-"));
  const cold = await proxyIn(coldDir, deadBase);
  check(JSON.stringify((await cold.listTools()).tools.map((t) => t.name)) === JSON.stringify(["bridge_offline"]),
    "with no cache and no daemon the proxy lists only bridge_offline");
  await cold.close();

  const warmDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-tools-"));
  fs.mkdirSync(path.join(warmDir, "ai-bridge"), { recursive: true });
  fs.writeFileSync(toolsFile(warmDir, deadBase), JSON.stringify({ ...cache, base: deadBase }));
  const warm = await proxyIn(warmDir, deadBase);
  const warmTools = (await warm.listTools()).tools.map((t) => t.name);
  check(JSON.stringify(warmTools) === JSON.stringify(liveTools) && !warmTools.includes("bridge_offline"),
    "a proxy started while the daemon is down lists the cached tools, not bridge_offline");
  const offlineJoin: any = await warm.callTool({ name: "join", arguments: { agent_id: "codex" } }, undefined, { timeout: 30_000 });
  check(offlineJoin.isError === true && /ai-bridge start/.test(offlineJoin.content?.[0]?.text ?? ""),
    "a call while the daemon is down returns a tool error that says how to start the bridge");
  await warm.close();

  await stopDaemon();
  await smokeAcp({ root: ROOT, base: BASE, codexEnv: { BRIDGE_CODEX_BIN: fakeCodex, CODEX_HOME: codexHome },
    startDaemon, stopDaemon, api, state, call, check });

  await stopDaemon();
  await smokeMemberNotes({ base: BASE, startDaemon, stopDaemon, api, call, check });
  // Runs its own daemons on the same port, so the fixture daemon must be stopped first.
  await stopDaemon();
  await smokeAcpProcess({ root: ROOT, port: PORT, check });
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await stopDaemon().catch(() => {});
}
console.log(failed ? "\nsmoke test FAILED" : "\nsmoke test passed");
console.log("project:", proj);
process.exit(failed ? 1 : 0);
