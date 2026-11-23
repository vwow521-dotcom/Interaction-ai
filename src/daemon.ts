// Bridge daemon: one process serving the MCP endpoint, the JSON API and the panel.
//   npm start -- --project <目标项目目录> [--port 7878]
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { buildAt } from "./release-asset.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { parseFolderCursor } from "./engine/folders.js";
import { buildServer } from "./mcp.js";
import type { BridgeClient } from "./products/types.js";
import { isRepo, dirtyFiles, show } from "./git.js";
import { PANEL_HTML } from "./panel.js";
import { toast } from "./notify.js";
import { configureAcpLedger, sweepAcpOrphans } from "./doorbells/acp-process.js";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const projectDir = path.resolve(arg("project") ?? process.env.BRIDGE_PROJECT ?? process.cwd());
if (!fs.existsSync(projectDir)) {
  console.error(`项目目录不存在：${projectDir}`);
  process.exit(1);
}
const PORT = Number(arg("port") ?? process.env.BRIDGE_PORT ?? 7878);

let cfg;
try {
  cfg = loadConfig(projectDir);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// ---------- MCP endpoint ----------
const transports = new Map<string, StreamableHTTPServerTransport>();

const app = express();
app.use(express.json({ limit: "4mb" }));

app.post("/mcp", async (req, res) => {
  const sid = req.header("mcp-session-id");
  let transport = sid ? transports.get(sid) : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(sid ? 404 : 400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session" }, id: null });
      return;
    }
    const socket = req.header("x-bridge-claude-socket");
    const pipe = req.header("x-bridge-claude-pipe");
    const hint = req.header("x-bridge-doorbell");
    const acpAgent = hint === "acp" ? req.header("x-bridge-agent") : undefined;
    if (hint === "acp" && (!acpAgent || !engine.doorbells.acp.connecting(acpAgent))) {
      res.status(409).json({ jsonrpc: "2.0", error: { code: -32000, message: "ACP worker is not running" }, id: null });
      return;
    }
    const client: BridgeClient = {
      name: req.header("x-bridge-client")?.slice(0, 160) ?? String(req.body.params.clientInfo?.name ?? "").slice(0, 160),
      claudeSocket: socket === "present" || socket === "absent"
        ? { present: socket === "present", pipe: pipe === "present" ? true : pipe === "absent" ? false : null }
        : req.header("x-bridge-doorbell") === "claude-socket" ? { present: true, pipe: null } : undefined,
    };
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, t);
        engine.presence.setSessionDoorbell(id, hint, acpAgent);
        engine.context.log("mcp_session_open", { session: id, client: req.body?.params?.clientInfo, upstream_client: client.name });
      },
    });
    t.onclose = () => {
      if (!t.sessionId) return;
      transports.delete(t.sessionId);
      engine.context.log("mcp_session_close", { session: t.sessionId });
      engine.presence.sessionClosed(t.sessionId);
    };
    await buildServer(engine, client, acpAgent).connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req: express.Request, res: express.Response) => {
  const t = transports.get(req.header("mcp-session-id") ?? "");
  if (!t) {
    res.status(404).send("Unknown session");
    return;
  }
  await t.handleRequest(req, res);
};
app.get("/mcp", sessionRequest);
app.delete("/mcp", sessionRequest);

// ---------- panel + JSON API ----------
const sseClients = new Set<express.Response>();
let changeTimer: NodeJS.Timeout | null = null;

// Static panel assets live next to src/ and dist/. Both earlier panels remain available.
const PANEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "panel");
app.get("/", (_req, res) => res.sendFile(path.join(PANEL_DIR, "index.html")));
app.get("/v1", (_req, res) => res.sendFile(path.join(PANEL_DIR, "v1", "room.html")));
app.use("/panel", express.static(PANEL_DIR, { index: false }));
app.get("/classic", (_req, res) => {
  res.type("html").send(PANEL_HTML);
});

app.get("/api/state", async (_req, res) => {
  res.json({ ...engine.workspace.snapshot(), daemon, git: { repo: await isRepo(projectDir), dirty: (await dirtyFiles(projectDir)).length } });
});
function queryId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
app.get("/api/folders", (req, res) => {
  const limit = req.query.limit === undefined ? 20 : queryId(req.query.limit);
  const before = typeof req.query.before === "string" ? parseFolderCursor(req.query.before) : null;
  if (limit === null || limit > 100 || (req.query.before !== undefined && !before))
    return void res.status(400).json({ error: "文件夹分页参数无效。" });
  res.json(engine.workspace.folderPage(limit, before ?? undefined));
});
app.get("/api/folders/:id", (req, res) => {
  if (!/^[mr][1-9]\d*$/.test(req.params.id)) return void res.status(404).json({ error: "文件夹不存在。" });
  const round = queryId(req.query.round);
  const before = queryId(req.query.handoffs_before);
  if ((req.query.round !== undefined && round === null) || (req.query.handoffs_before !== undefined && before === null))
    return void res.status(400).json({ error: "轮次或交接分页参数无效。" });
  const folder = engine.workspace.folderDetail(req.params.id, round ?? undefined, before ?? undefined);
  if (!folder) return void res.status(404).json({ error: "文件夹不存在。" });
  res.json(folder);
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("data: hello\n\n");
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

const reply = (res: express.Response, r: Record<string, unknown>) => res.status(r.error ? 409 : 200).json(r);

app.post("/api/runs", (req, res) => {
  const goal = String(req.body?.goal ?? "").trim();
  if (!goal) return void res.status(400).json({ error: "目标不能为空" });
  reply(res, engine.scheduler.startRun(goal));
});
app.post("/api/runs/stop", (_req, res) => reply(res, engine.scheduler.stopRun()));
app.post("/api/attempts/:id/decide", (req, res) => {
  const action = req.body?.action;
  if (action !== "approve" && action !== "reject") return void res.status(400).json({ error: "action 必须是 approve 或 reject" });
  reply(res, engine.scheduler.decide(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings", (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (!topic) return void res.status(400).json({ error: "议题不能为空" });
  const parts = Array.isArray(req.body?.participants) ? req.body.participants.map(String) : undefined;
  reply(res, engine.meetings.startMeeting(topic, parts, req.body?.facilitator ? String(req.body.facilitator) : undefined));
});
app.post("/api/meetings/:id/next", (req, res) => {
  const action = req.body?.action;
  if (action !== "critique" && action !== "finalize") return void res.status(400).json({ error: "action 必须是 critique 或 finalize" });
  reply(res, engine.meetings.meetingNext(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings/:id/decide", async (req, res) => {
  const action = req.body?.action;
  if (action !== "approve" && action !== "reject") return void res.status(400).json({ error: "action 必须是 approve 或 reject" });
  reply(res, await engine.meetings.meetingDecide(Number(req.params.id), action, String(req.body?.note ?? "")));
});
app.post("/api/meetings/:id/cancel", (req, res) => reply(res, engine.meetings.meetingCancel(Number(req.params.id))));
app.post("/api/questions/:id/answer", (req, res) => {
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return void res.status(400).json({ error: "回答不能为空" });
  reply(res, engine.workspace.answer(Number(req.params.id), answer));
});
app.post("/api/agents/:id/release", (req, res) => reply(res, engine.presence.release(req.params.id, "human")));
app.post("/api/agents/:id/acp/stop", async (req, res) => {
  const stop = engine.doorbells.acp.stop(req.params.id);
  if (!stop) return void reply(res, { error: "该成员没有 ACP 配置" });
  await stop;
  reply(res, { ok: true });
});
app.post("/api/agents/:id/acp/restart", async (req, res) => {
  const id = req.params.id;
  if (!engine.doorbells.acp.snapshot(id)) return void reply(res, { error: "该成员没有 ACP 配置" });
  engine.doorbells.resetCooldown(id, "acp");
  try {
    await engine.doorbells.acp.restart(id);
    reply(res, { ok: true });
  } catch (error) {
    reply(res, { error: (error as Error).message });
  }
});

// The human's chat: `mentions` and/or @names in the text pick who is woken.
app.post("/api/chat", (req, res) => {
  const mentions = Array.isArray(req.body?.mentions) ? req.body.mentions.map(String) : [];
  const replyTo = req.body?.reply_to ? Number(req.body.reply_to) : undefined;
  reply(res, engine.chat.post("human", String(req.body?.text ?? ""), mentions, replyTo));
});
// One agent's message box: a chat message to that agent. `id` is its mail (the receipt).
app.post("/api/mail", (req, res) => {
  const to = String(req.body?.to ?? "");
  if (!engine.presence.isAgent(to)) return void res.status(409).json({ error: "未知收件人" });
  const r = engine.chat.post("human", String(req.body?.text ?? ""), [to]);
  reply(res, r.error ? r : { ...r, id: (r.mail_ids as Record<string, string>)[to] });
});

// Parked doorbells: the stdio proxy (claude-socket) and a parking Codex Stop hook (codex-hook) long-poll here.
app.get("/api/doorbell/wait", async (req, res) => {
  const agent = String(req.query.agent ?? "");
  const kind = String(req.query.kind ?? "");
  if (!engine.presence.isAgent(agent) || !["claude-socket", "codex-hook"].includes(kind))
    return void res.status(400).json({ error: "agent 或 kind 无效" });
  // New Claude proxies tie their parked doorbell to the bound MCP session.
  const session = kind === "claude-socket" ? req.get("mcp-session-id") : undefined;
  const stillBound = () => !session || engine.presence.get(agent)?.sessionId === session;
  const disconnected = () => res.status(409).json({ reconnect: !!session && !transports.has(session) });
  if (!stillBound()) return void disconnected();
  const timeoutMs = Math.min(Math.max(Number(req.query.timeout ?? 50), 1), 55) * 1000;
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const r = await engine.postman.doorbellWait(agent, kind as "claude-socket" | "codex-hook", timeoutMs, ac.signal);
  if (!res.writableEnded && !ac.signal.aborted && stillBound()) return void res.json(r);
  if (!res.writableEnded && !ac.signal.aborted) disconnected();
  if (r.ring && r.mailIds) engine.postman.doorbellResult(agent, r.mailIds, false, "门铃连接在送达前断开", kind as "claude-socket" | "codex-hook");
});
app.post("/api/doorbell/result", (req, res) => {
  const agent = String(req.body?.agent ?? "");
  if (!engine.presence.isAgent(agent)) return void res.status(400).json({ error: "agent 无效" });
  engine.postman.doorbellResult(agent, Array.isArray(req.body?.mailIds) ? req.body.mailIds.map(String) : [], !!req.body?.ok, req.body?.error);
  res.json({ ok: true });
});
// Where an agent's client can be reached outside MCP. The Codex Stop hook registers its conversation id
// (kind "codex-thread") at the end of every turn; the answer tells it whether to park as the doorbell.
app.post("/api/agents/:id/endpoint", (req, res) => {
  reply(res, engine.postman.registerEndpoint(req.params.id, String(req.body?.kind ?? ""), String(req.body?.address ?? "")));
});
// A Stop hook with evidence of a drifted join format can report it without registering a thread.
app.post("/api/diagnostics/codex-transcript", async (req, res) => {
  const thread = req.body?.session_id;
  if (typeof thread !== "string" || !/^[\w-]{1,160}$/.test(thread))
    return void res.status(400).json({ error: "session_id 无效" });
  await engine.diagnostics.transcriptDrift(thread, req.body?.version);
  res.json({ ok: true });
});
// Pre-0.5 hooks.
app.post("/api/codex/thread", (req, res) => {
  reply(res, engine.postman.registerEndpoint(String(req.body?.agent ?? ""), "codex-thread", String(req.body?.session_id ?? "")));
});

app.get("/api/commits/:sha", async (req, res) => {
  res.type("text/plain; charset=utf-8").send(await show(projectDir, req.params.sha));
});

const server = createServer(app);
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
    const url = `http://127.0.0.1:${PORT}`;
    let existing: unknown;
    try {
      const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) existing = (await response.json()).project;
    } catch { /* The port may belong to another service. */ }
    console.error(`端口 ${PORT} 已被占用（EADDRINUSE）。`);
    if (typeof existing === "string") console.error(`已有协作桥正在运行，项目为 ${existing}，面板为 ${url}/。`);
    console.error("如需另起实例，请用 ai-bridge start <项目目录> --port <空闲端口>。");
  } else {
    console.error(`无法监听端口 ${PORT}：${(error as Error).message}`);
  }
  process.exit(1);
}

const address = server.address();
const port = typeof address === "object" && address ? address.port : PORT;
const installDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = buildAt(installDir, import.meta.url.endsWith(".ts"));
const daemon = {
  version: JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")).version,
  commit: build.commit ?? "unknown", dirty: build.dirty ?? null, channel: build.channel,
  built_at: build.builtAt ?? null, started_at: new Date().toISOString(),
  project: projectDir, port, install_dir: installDir,
};
const bridgeUrl = `http://127.0.0.1:${port}`;
const engine = new Engine(cfg, new Store(projectDir), bridgeUrl, async (agent) => {
  const owned = [...transports].filter(([id]) => engine.presence.acpAgent(id) === agent);
  for (const [id] of owned) {
    transports.delete(id);
    engine.presence.sessionClosed(id);
  }
  await Promise.allSettled(owned.map(([, transport]) => transport.close()));
});
engine.presence.isSessionOpen = (id) => transports.has(id);
// Windows: end ACP agents a previous daemon left behind (crash, force kill), before anything can spawn new ones.
// This is synchronous so no timer or request runs first; it costs one PowerShell query, and only when the
// ledger has entries.
configureAcpLedger(path.join(projectDir, ".bridge", "acp-hosts.json"), projectDir);
for (const r of sweepAcpOrphans()) {
  const role = { supervisor: "监督进程", agent: "代理进程", entry: "台账记录" }[r.role];
  engine.context.log(r.kind, { agent: r.agent, role: r.role, pid: r.pid, reason: r.reason });
  engine.context.event(null, r.agent, r.kind, r.kind === "acp_orphan_killed"
    ? `${r.agent} · 结束了上次遗留的${role}（PID ${r.pid}）`
    : `${r.agent} · 未清理${role}（PID ${r.pid}）：${r.reason}`);
}
engine.context.notifyHuman = (title, body) => {
  if (cfg.notify.enabled) toast(title, body, `http://127.0.0.1:${port}/`);
};
engine.context.onChange = () => {
  if (changeTimer) return; // coalesce bursts
  changeTimer = setTimeout(() => {
    changeTimer = null;
    for (const c of sseClients) c.write("data: change\n\n");
  }, 150);
};

async function shutdown() {
  if (engine.postman.shuttingDown) return;
  engine.postman.shuttingDown = true;
  await engine.doorbells.acp.shutdown();
  for (const client of sseClients) client.end();
  await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
  server.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
  if (signal !== "SIGBREAK" || process.platform === "win32") process.on(signal, () => void shutdown());
}
if (process.send) {
  // A supervising process can request a graceful shutdown on Windows, where child.kill() is immediate.
  process.on("message", (message) => { if (message === "shutdown") void shutdown(); });
  process.on("disconnect", () => void shutdown());
}

engine.context.log("server_start", { port, project: projectDir, config: cfg.source, pollSeconds: cfg.wait.poll_seconds });
const repo = await isRepo(projectDir);
console.log(`项目:  ${projectDir}${repo ? "" : "  （警告：不是 git 仓库，交接不会自动提交）"}`);
console.log(`配置:  ${cfg.source}`);
console.log(`MCP:   http://127.0.0.1:${port}/mcp`);
console.log(`面板:  http://127.0.0.1:${port}/`);
for (const agent of engine.presence.agentIds()) {
  if (engine.doorbells.chain(agent).includes("acp") && engine.doorbells.acp.possible(agent)) engine.postman.retryAcpMail(agent);
}
