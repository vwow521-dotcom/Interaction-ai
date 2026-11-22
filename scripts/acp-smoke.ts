import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";

interface Fixture {
  root: string;
  base: string;
  codexEnv: Record<string, string>;
  startDaemon(project: string, wakeGrace: string, env: Record<string, string>): Promise<void>;
  stopDaemon(): Promise<void>;
  api(path: string, body?: object): Promise<{ status: number; json: any }>;
  state(): Promise<any>;
  call(client: Client, method: string, args: object): Promise<any>;
  check(ok: unknown, message: string): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, description: string, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await sleep(35);
  }
  throw new Error("ACP: " + description);
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readTrace(file: string): any[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : [];
}

export async function smokeAcp({ root, base, codexEnv, startDaemon, stopDaemon, api, state, call, check }: Fixture) {
  console.log("\nK. ACP background members");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-acp-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "bridge-smoke");
  git("config", "user.email", "bridge-smoke@example.invalid");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(project, "README.md"), "ACP fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "init");

  const logs = {
    stdio: path.join(project, "stdio.jsonl"), http: path.join(project, "http.jsonl"), fault: path.join(project, "fault.jsonl"),
  };
  const methods = (agent: keyof typeof logs) => readTrace(logs[agent]);
  const events = (agent: keyof typeof logs, kind: string) => methods(agent).filter((entry) => entry.event === kind);
  const trace = () => readTrace(path.join(project, ".bridge", "bridge-log.jsonl"));
  const bridgeEvents = (agent: string, kind: string) => trace().filter((row) => row.agent === agent && row.event === kind);
  const command = process.execPath;
  const args = ["%BRIDGE_FIXTURE_AGENT%"];
  const staleAfterSeconds = 4;
  const acpEnv = (agent: keyof typeof logs) => ({
    BRIDGE_FIXTURE_AGENT: path.join(root, "scripts", "fake-acp-agent.mjs"),
    FAKE_ACP_LOG: logs[agent], FAKE_ACP_TURN_MS: "1200", FAKE_ACP_PERMISSIONS: "1",
    TMP: project, TEMP: project, TMPDIR: project,
  });
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: {
      stdio: { product: "antigravity", acp: { command: "%BRIDGE_FIXTURE_NODE%", args, mode: "accept-edits", permissions: "allow",
        env: { ...acpEnv("stdio"), BRIDGE_FIXTURE_NODE: command, FAKE_ACP_CRASH_AT: "4", FAKE_ACP_CANCEL_DELAY_MS: "4100" } } },
      http: { product: "deepseek-harness", acp: { command, args, mcp: "http", permissions: "deny",
        env: { ...acpEnv("http"), FAKE_ACP_CRASH_AT: "2", FAKE_ACP_IGNORE_CANCEL: "1" } } },
      fault: { doorbell: "acp", acp: { command, args, mcp: "http",
        env: { ...acpEnv("fault"), FAKE_ACP_CRASH_AT: "initialize", FAKE_ACP_CRASH_LIMIT: "3" } } },
      planner: { doorbell: "poll" },
    },
    pipeline: [
      { id: "implement", role: "实现", agent: "stdio", owns: ["README.md"] },
      { id: "review", role: "审查", agent: "http", gate: true, on_reject: "implement" },
    ],
    wait: { poll_seconds: 3, stale_after_seconds: staleAfterSeconds, offline_after_seconds: 90 },
    doorbells: { max_unconfirmed_rings: 1, cooldown_seconds: 60 },
    notify: { enabled: false },
  }));
  // Fixture telemetry stays out of the commits made by the pipeline.
  fs.appendFileSync(path.join(project, ".git", "info", "exclude"), "\n/*.jsonl*\n/bridge.config.yaml\n/ai-bridge/\n");
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: "smoke-ignored", CLAUDE_CODE_MESSAGING_TOKEN: "smoke-ignored",
    CLAUDE_CODE_ENTRYPOINT: "smoke-ignored", BRIDGE_ACP_RETRY_SECONDS: "0.9", BRIDGE_ACP_CANCEL_GRACE_SECONDS: "6", GIT_OPTIONAL_LOCKS: "1" };
  const member = async (id: string) => (await state()).agents.find((a: any) => a.id === id);
  const chat = async (id: string, text: string) => (await api("/api/chat", { text: `@${id} ${text}` })).json.mail_ids[id];
  const hasFetched = (agent: keyof typeof logs, id: string) => events(agent, "fetched").some((row) => row.ids.includes(id));
  const waitForGate = () => until(async () => {
    const snapshot = await state();
    return snapshot.run?.status === "awaiting_approval" ? snapshot : null;
  }, "stdio implementation and HTTP review did not reach approval");
  const approve = async (gate: any) => {
    const review = gate.attempts.find((attempt: any) => attempt.status === "awaiting_approval");
    assert.equal((await api("/api/attempts/" + review.id + "/decide", { action: "approve" })).status, 200);
  };

  await startDaemon(project, "8", env);
  check((await member("stdio")).acp.state === "not_started" && !methods("stdio").length, "ACP workers are lazy");
  const interactive = new Client({ name: "antigravity-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  await interactive.connect(transport);
  try {
    const joined = await call(interactive, "join", {});
    check(joined.agent_id === "stdio" && joined.doorbell === "poll", "interactive Antigravity gets identity and poll instructions");
    const poll = call(interactive, "wait_for_mail", { agent_id: "stdio" });
    await until(async () => (await member("stdio")).status === "waiting", "interactive wait did not start");
    const polled = await chat("stdio", "deliver to active poll");
    check((await poll).mails.some((m: any) => m.id === polled) && !methods("stdio").length, "a blocked poll takes priority over ACP");
    const gapMail = await chat("stdio", "deliver in the gap between polls");
    check(!methods("stdio").length && (await member("stdio")).acp.state === "not_started", "a recent poll keeps priority between calls");
    const gap = await call(interactive, "wait_for_mail", { agent_id: "stdio" });
    check(gap.mails.some((m: any) => m.id === gapMail), "the next interactive poll fetches queued mail");
    await sleep(staleAfterSeconds * 1000 + 50);

    check((await api("/api/runs", { goal: "ACP two-stage fixture" })).status === 200, "ACP pipeline starts");
    await until(() => events("stdio", "fetched").length, "stdio ACP did not fetch the task");
    const replaced = await call(interactive, "fetch_inbox", { agent_id: "stdio" });
    check(/后台会话正在处理/.test(replaced.error), "the ACP join automatically takes over an inactive interactive binding");
    const duringTurn = await member("stdio");
    check(duringTurn.acp.state === "running" && duringTurn.activity.state === "working", "ACP updates feed the member activity");
    const gate = await waitForGate();
    check(gate.handoffs.length === 2 && gate.handoffs.every((h: any) => !!h.commit_sha) && gate.handoffs[1].data.verdict === "approve"
      && git("rev-list", "--count", "HEAD") === "3", "stdio and HTTP both fetched, handed off, and created commits");
    check(events("stdio", "session/set_mode").some((row) => row.modeId === "accept-edits")
      && events("stdio", "mcp_connected")[0]?.name === "bridge_acp"
      && events("stdio", "joined")[0]?.doorbell === "acp" && events("http", "joined")[0]?.doorbell === "acp"
      && /不要调用 wait_for_mail/.test(events("http", "joined")[0]?.protocol ?? ""), "managed sessions get ACP identity and the configured mode");
    check(events("stdio", "decision")[0]?.outcome?.optionId === "allow" && events("http", "decision")[0]?.outcome?.optionId === "deny"
      && gate.events.filter((e: any) => e.kind === "acp_permission").length >= 2, "allow and deny select the correct option and record both decisions");
    check(["stdio", "http"].every((id) => {
      const row = events(id as keyof typeof logs, "environment")[0];
      return row?.doorbell === "acp" && row.bridgeAgent === id && !row.claudeKeys.length;
    }), "ACP environment supplies its own identity and strips every Claude variable");
    const output = (await member("stdio")).acp.output;
    check(output.length === 50 && output.at(-1) === "输出末行", "only the last 50 output lines are available in the panel");
    await approve(gate);
  } finally {
    await transport.terminateSession().catch(() => {});
    await interactive.close();
  }

  const initialSession = events("stdio", "session/prompt")[0].sessionId;
  const first = await chat("stdio", "first active turn");
  await until(() => hasFetched("stdio", first), "first chat was not fetched");
  const second = await chat("stdio", "queued while first turn is active");
  await sleep(50);
  check(events("stdio", "session/prompt").length === 2 && !hasFetched("stdio", second), "a busy ACP member does not get an overlapping prompt");
  await until(() => hasFetched("stdio", second), "ACP did not deliver the second chat after the turn ended");
  await until(async () => (await member("stdio")).acp.state === "ready", "follow-up turn did not finish");
  check(events("stdio", "session/prompt").length === 3 && events("stdio", "session/new").length === 1,
    "ACP sends one follow-up and reuses the long-lived session");

  const crashed = await chat("stdio", "retry after a crash");
  const retry = await until(async () => {
    const acp = (await member("stdio")).acp;
    return acp.state === "retrying" ? acp : null;
  }, "ACP crash did not enter backoff");
  check(!!retry.retryAt && /47/.test(retry.reason), "ACP crash reports its code and retry deadline");
  await until(() => hasFetched("stdio", crashed), "ACP did not recover and fetch after its backoff");
  const resumed = events("stdio", "session/resume")[0];
  check(resumed?.sessionId === initialSession && resumed.pid !== events("stdio", "session/new")[0].pid, "crash recovery resumes the same session in a new process");

  await until(async () => (await member("stdio")).acp.state === "ready", "resumed turn did not finish");
  const plannerTransport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const planner = new Client({ name: "planner", version: "1.0.0" });
  await planner.connect(plannerTransport);
  try {
    assert.equal((await call(planner, "join", { agent_id: "planner" })).agent_id, "planner");
    const meetingRun = async (topic: string, tasks: { id: string; owner: string; paths: string[] }[]) => {
      const meeting = await api("/api/meetings", { topic, participants: ["planner"] });
      assert.equal(meeting.status, 200);
      const id = meeting.json.meeting_id;
      const speak = async (plan?: typeof tasks) => {
        await call(planner, "fetch_inbox", { agent_id: "planner" });
        const result = await call(planner, "submit_meeting_turn", {
          agent_id: "planner", meeting_id: id, content: topic, tasks: plan?.map((task) => ({ ...task, title: task.id })),
        });
        assert.equal(result.status, "submitted");
      };
      await speak();
      assert.equal((await api(`/api/meetings/${id}/next`, { action: "finalize" })).status, 200);
      await speak(tasks);
      const approved = await api(`/api/meetings/${id}/decide`, { action: "approve" });
      assert.equal(approved.status, 200);
      return approved.json.run_id;
    };

    const oldRun = await meetingRun("delayed ACP cancellation", [{ id: "T1", owner: "stdio", paths: ["README.md"] }]);
    const oldWorker = await until(async () => {
      const worker = await member("stdio");
      return worker.doing.some((a: any) => a.status === "in_progress") ? worker : null;
    }, "ACP did not fetch the old scoped task");
    const prompts = events("stdio", "session/prompt").length;
    assert.equal((await api("/api/runs/stop", {})).status, 200);
    await until(() => events("stdio", "session/cancel").length, "ACP never received session/cancel");
    const duringCancel = await chat("stdio", "deliver after cancellation");
    const newRun = await meetingRun("new run with overlapping and disjoint paths", [
      { id: "T1", owner: "planner", paths: ["README.md"] },
      { id: "T2", owner: "planner", paths: ["OTHER.md"] },
    ]);
    const waiting = await state();
    check(waiting.run.id === newRun && waiting.tasks[0].status === "pending" && waiting.tasks[1].status === "active"
      && waiting.leases.some((lease: any) => lease.run_id === oldRun && lease.glob === "README.md"),
    "cancelled task retains its lease while only the disjoint task starts in the next run");
    check(events("stdio", "session/prompt").length === prompts && !hasFetched("stdio", duringCancel)
      && waiting.mail.some((mail: any) => mail.id === duringCancel && mail.status === "queued"),
    "mail arriving during cancellation stays queued without spending a ring or starting an overlapping prompt");
    const cancelled = await until(() => bridgeEvents("stdio", "acp_cancel_end").at(-1), "no timing for the completed cancellation");
    await until(async () => (await state()).tasks[0].status === "active", "overlapping task did not start after cancellation");
    const afterCancel = await state();
    check(cancelled.outcome === "cancelled" && cancelled.elapsedMs > 3000 && bridgeEvents("stdio", "acp_cancel_timeout").length === 0
      && alive(oldWorker.acp.pid) && (await member("stdio")).acp.pid === oldWorker.acp.pid
      && !afterCancel.leases.some((lease: any) => lease.run_id === oldRun),
    "a delayed cancellation over three seconds preserves the ACP process and releases the stopped run's lease");
    await until(() => hasFetched("stdio", duringCancel), "valid mail was not fetched after cancellation");
    check(events("stdio", "session/prompt").length === prompts + 1 && events("stdio", "session/prompt").at(-1).sessionId === initialSession,
      "one follow-up prompt fetches valid mail in the same ACP session");
    assert.equal((await api("/api/runs/stop", {})).status, 200);
    await until(async () => (await member("stdio")).acp.state === "ready", "post-cancellation follow-up did not finish");

    await meetingRun("unresponsive ACP cancellation", [{ id: "T1", owner: "http", paths: ["README.md"] }]);
    await until(async () => (await member("http")).acp.state === "retrying", "expected one real process failure first");
    const unacked = await call(planner, "send_mail", {
      agent_id: "planner", to: "http", subject: "still valid", body: "ack after recovery", ack_required: true,
    });
    await until(() => hasFetched("http", unacked.id), "valid mail was not fetched before the timeout");
    const httpBefore = (await member("http")).acp.pid;
    const sessionBefore = events("http", "session/prompt").at(-1).sessionId;
    const resumesBefore = events("http", "session/resume").length;
    assert.equal((await api("/api/runs/stop", {})).status, 200);
    await until(() => events("http", "session/cancel").length, "HTTP agent never received cancel");
    const pipelined = await api("/api/runs", { goal: "unscoped pipeline during cancellation" });
    assert.equal(pipelined.status, 200);
    check((await state()).tasks[0].status === "pending", "an unscoped pipeline waits for the cancelled ACP task");
    const timeout = await until(() => bridgeEvents("http", "acp_cancel_timeout").at(-1), "unresponsive ACP cancellation did not time out");
    const killed = await until(() => bridgeEvents("http", "acp_cancel_end").at(-1), "unresponsive ACP agent did not exit");
    await until(() => events("http", "fetched").filter((row) => row.ids.includes(unacked.id)).length === 2, "valid unacknowledged mail was not redelivered");
    const failed = bridgeEvents("http", "acp_exit").filter((event) => event.failures);
    const recovered = events("http", "session/resume").at(-1);
    check(timeout.failures === 1 && timeout.graceMs === 6000 && failed.length === 1 && failed[0].failures === 1
      && killed.outcome === "timeout" && !alive(httpBefore) && events("http", "session/resume").length === resumesBefore + 1
      && recovered.sessionId === sessionBefore && recovered.pid !== httpBefore,
    "timeout ends the process without counting a failure or entering backoff, and valid mail resumes the old session");
    const gate = await waitForGate();
    const ordering = trace();
    const finishedAt = ordering.findIndex((row) => row.event === "acp_cancel_end" && row.agent === "http" && row.outcome === "timeout");
    const startedAt = ordering.findIndex((row) => row.event === "task_start" && row.run === pipelined.json.run_id);
    check(finishedAt >= 0 && startedAt > finishedAt && gate.mail.some((mail: any) => mail.id === unacked.id && mail.status === "acked"),
      "the unscoped pipeline starts after process exit and the original unacknowledged mail is acknowledged");
    await approve(gate);
  } finally {
    await plannerTransport.terminateSession().catch(() => {});
    await planner.close();
  }

  const failingMail = await chat("fault", "three consecutive ACP process failures");
  const stopped = await until(async () => {
    const worker = await member("fault");
    return worker.acp.state === "stopped" ? worker : null;
    // Three spawns, each with supervisor start and PowerShell identity recording (~2 s, more under load), plus two retry waits.
  }, "three process failures did not stop automatic retry", 45_000);
  const failures = bridgeEvents("fault", "acp_exit");
  check(failures.map((row) => row.failures).join(",") === "1,2,3"
    && failures[0].retryAt && failures[1].retryAt && failures[2].retryAt === undefined
    && stopped.doorbellStats.find((stat: any) => stat.kind === "acp")?.degradedUntil === null,
  "two driver retries run despite a one-failure doorbell threshold, then the third failure stops the member");
  assert.equal((await api("/api/agents/fault/acp/restart", {})).status, 200);
  await until(() => hasFetched("fault", failingMail), "manual restart did not deliver the queued mail");
  check(events("fault", "initialize").length === 4 && events("fault", "session/prompt").length === 1,
    "manual restart recovers mail after the three-failure stop");

  const http = (await member("http")).acp;
  const httpResumes = events("http", "session/resume").length;
  check((await api("/api/agents/http/acp/stop", {})).status === 200 && !alive(http.pid)
    && (await member("http")).acp.state === "stopped" && events("http", "session/close").length === 1,
    "stopping a background member closes its session and exits its process");
  check((await api("/api/agents/http/acp/restart", {})).status === 200
    && (await member("http")).acp.state === "ready" && events("http", "session/resume").length === httpResumes + 1,
    "restarting a member resumes its session inside the same daemon");
  const pids = [(await member("stdio")).acp.pid, (await member("http")).acp.pid];
  await stopDaemon();
  check(pids.every((pid) => pid && !alive(pid)) && events("stdio", "session/close").some((line) => line.pid === pids[0]),
    "daemon shutdown closes the ACP sessions and leaves no agent processes");

  await startDaemon(project, "8", env);
  const newHttp = await chat("http", "use fresh MCP after daemon restart");
  await until(() => hasFetched("http", newHttp), "HTTP worker did not fetch after daemon restart");
  const httpPrompts = events("http", "session/prompt");
  check(events("http", "session/new").length === 2 && events("http", "session/resume").length === httpResumes + 1
    && httpPrompts[0].sessionId !== httpPrompts.at(-1).sessionId, "HTTP starts a fresh ACP session after a daemon restart");
  await until(async () => (await member("http")).acp.state === "ready", "HTTP turn after restart did not finish");

  const before = { stdio: methods("stdio").length, http: methods("http").length };
  const doctor = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--probe", "--project", project], {
    cwd: root, env: { ...process.env, ...codexEnv, ...env, BRIDGE_URL: base }, encoding: "utf8", windowsHide: true, timeout: 20_000,
  });
  check((["stdio", "http"] as const).every((id) => {
    const added = methods(id).slice(before[id]).filter((entry) => entry.event !== "environment");
    return added.length === 1 && added[0].event === "initialize" && !alive(added[0].pid);
  }) && /stdio：ACP fake-acp 1\.0\.0/.test(doctor) && /http：ACP fake-acp 1\.0\.0/.test(doctor),
  "doctor --probe reports ACP capabilities, sends only initialize, and exits both probes");
}
