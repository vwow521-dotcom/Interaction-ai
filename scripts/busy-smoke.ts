// 0.12 long-command heartbeat: report_progress(busy_minutes) suppresses ack_overdue for the agent's current attempt only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";

interface Fixture {
  base: string;
  startDaemon(project: string, wakeGrace?: string, env?: Record<string, string>): Promise<void>;
  stopDaemon(): Promise<void>;
  api(path: string, body?: object): Promise<{ status: number; json: any }>;
  call(client: Client, method: string, args: Record<string, unknown>): Promise<any>;
  check(ok: unknown, message: string): void;
}

const MINUTE_MS = 1500; // one busy_minutes "minute" in this test
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeBusy({ base, startDaemon, stopDaemon, api, call, check }: Fixture) {
  console.log("\nLong-command heartbeat (busy_minutes)");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-busy-"));
  execFileSync("git", ["init", "-q", project]);
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: { bob: { doorbell: "poll" }, rev: { doorbell: "poll" } },
    pipeline: [
      { id: "implement", role: "实现", agent: "bob" },
      { id: "polish", role: "收尾", agent: "bob" },
      { id: "review", role: "审查", agent: "rev", gate: true, on_reject: "implement" },
    ],
    git: { auto_commit: false },
    mail: { ring_retry_seconds: 1, max_rings: 1, ack_timeout_seconds: 2 },
    notify: { enabled: false },
  }, { lineWidth: 0 }));

  const clients: Client[] = [];
  const connect = async (name: string) => {
    const c = new Client({ name: `busy-smoke-${name}`, version: "0.0.1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    clients.push(c);
    return c;
  };
  const state = async () => (await api("/api/state")).json;
  const bob = (s: any) => s.agents.find((a: any) => a.id === "bob");
  const busyUntil = async () => bob(await state()).activity.busy_until as string | null;
  const overdue = (s: any, id: string) => s.mail.find((m: any) => m.id === id)?.overdue;
  const progressEvents = (s: any) => s.events.filter((e: any) => e.kind === "progress" && e.agent === "bob").length;
  // A schema rejection comes back as an MCP error (thrown or isError), not as the bridge's JSON.
  const refused = async (c: Client, args: Record<string, unknown>) => {
    try {
      const r: any = await c.callTool({ name: "report_progress", arguments: { agent_id: "bob", text: "长命令", ...args } });
      if (r.isError) return true;
      return !!JSON.parse(r.content[0].text).error;
    } catch {
      return true;
    }
  };
  const waitOverdue = async (id: string, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (overdue(await state(), id)) return Date.now();
      await sleep(250);
    }
    return null;
  };
  const taskMail = (r: any) => r.mails.find((m: any) => m.kind === "task" && !m.void);

  try {
    await startDaemon(project, "6", { BRIDGE_BUSY_MINUTE_MS: String(MINUTE_MS) });
    const b1 = await connect("bob");
    await call(b1, "join", { agent_id: "bob" });
    await api("/api/runs", { goal: "长命令心跳" });

    // Invalid values and a missing in-progress attempt leave no trace.
    let s = await state();
    const before = progressEvents(s);
    const noAttempt = await call(b1, "report_progress", { agent_id: "bob", text: "还没领任务", busy_minutes: 5 });
    const bad = [await refused(b1, { busy_minutes: 0 }), await refused(b1, { busy_minutes: 61 }),
      await refused(b1, { busy_minutes: 1.5 }), await refused(b1, { busy_minutes: "5" })];
    s = await state();
    check(!!noAttempt.error && bad.every(Boolean) && progressEvents(s) === before && bob(s).activity.busy_until === null,
      "busy_minutes outside 1–60, non-integers, strings and calls without an in-progress attempt are refused without side effects");

    // Busy period covers the task mail past ack_timeout_seconds, then the old rule applies again.
    const m1 = taskMail(await call(b1, "fetch_inbox", { agent_id: "bob" })).id;
    const r1 = await call(b1, "report_progress", { agent_id: "bob", text: "跑完整 smoke", busy_minutes: 8 });
    const until1 = Date.parse(r1.busy_until);
    s = await state();
    check(r1.ok && Math.abs(until1 - Date.now() - 8 * MINUTE_MS) < 1500 && bob(s).activity.busy_until === r1.busy_until &&
      s.events.some((e: any) => e.kind === "progress" && e.text.includes("执行长命令")),
      "busy_minutes returns busy_until, shows on the member's activity and in the progress event");
    await sleep(until1 - Date.now() - 1000); // past ack_timeout (2 s) and at least one 5 s sweep, still inside the period
    check(overdue(await state(), m1) === false, "no ack_overdue while busy_until is ahead, although ack_timeout_seconds passed");
    const flagged = await waitOverdue(m1, 15_000);
    check(flagged !== null && flagged >= until1 && (await busyUntil()) === null,
      "after busy_until passes with no activity the task mail is flagged as usual and the panel drops the busy line");

    // A refused handoff keeps the period; a plain report clears it; a successful handoff ends it.
    await call(b1, "report_progress", { agent_id: "bob", text: "再跑一次", busy_minutes: 30 });
    const refusedHandoff = await call(b1, "submit_handoff", { agent_id: "bob", summary: "带了 issues", issues: [{ problem: "x" }] });
    check(!!refusedHandoff.error && (await busyUntil()) !== null, "a handoff refused by validation keeps busy_until");
    await call(b1, "report_progress", { agent_id: "bob", text: "跑完了" });
    check((await busyUntil()) === null, "report_progress without busy_minutes clears the period");
    await call(b1, "report_progress", { agent_id: "bob", text: "最后一遍", busy_minutes: 30 });
    const done = await call(b1, "submit_handoff", { agent_id: "bob", summary: "实现完成" });
    check(done.status === "submitted" && (await busyUntil()) === null, "a successful handoff ends the period");

    // The next attempt does not inherit it, a takeover drops it, and a new report replaces the old one.
    const m2 = taskMail(await call(b1, "fetch_inbox", { agent_id: "bob" })).id;
    check((await busyUntil()) === null, "the next stage of the same agent starts without a busy period");
    await call(b1, "report_progress", { agent_id: "bob", text: "收尾长命令", busy_minutes: 30 });
    const b2 = await connect("bob-2");
    await call(b2, "join", { agent_id: "bob", takeover: true });
    check((await busyUntil()) === null, "a takeover by another session drops the busy period");
    const long = await call(b2, "report_progress", { agent_id: "bob", text: "接管后长命令", busy_minutes: 30 });
    const short = await call(b2, "report_progress", { agent_id: "bob", text: "改成短一点", busy_minutes: 2 });
    const until2 = Date.parse(short.busy_until);
    check(until2 < Date.parse(long.busy_until) && (await busyUntil()) === short.busy_until,
      "a later report with busy_minutes replaces the earlier period, counted from that report");
    const flagged2 = await waitOverdue(m2, 15_000);
    check(flagged2 !== null && flagged2 >= until2, "the replaced, shorter period expires and the mail is flagged on time");
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await stopDaemon();
  }
}
