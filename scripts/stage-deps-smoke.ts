import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";
import { Store } from "../src/store.js";

interface Fixture {
  root: string;
  port: number;
  check(ok: unknown, message: string): void;
}

interface MailItem {
  id: string;
  kind: string;
  subject: string;
  ack_required: boolean;
  body?: string;
  task?: any;
}

const memberIds = ["up", "down", "critic", "cross", "late", "guard"];
const task = (id: string, owner: string, file: string, depends_on: string[] = [], reviewer?: string) => ({
  id, title: id, owner, reviewer, paths: [file], depends_on,
});

export async function smokeStageDeps({ root, port, check }: Fixture) {
  console.log("\nStage dependencies and review priority");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-stage-deps-"));
  const base = `http://127.0.0.1:${port}`;
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const write = (file: string, content: string) => fs.writeFileSync(path.join(project, file), content);
  const configure = (gate: boolean) => write("bridge.config.yaml", YAML.stringify({
    agents: Object.fromEntries(memberIds.map((id) => [id, { doorbell: "poll" }])),
    pipeline: [{ id: "implement", role: "实现", agent: "up" }],
    task_template: [
      { id: "implement", role: "实现", agent: "owner", gate },
      { id: "review", role: "审查", agent: "reviewer", gate: true, on_reject: "implement" },
    ],
    notify: { enabled: false },
  }));
  git("init", "-q");
  git("config", "user.name", "bridge-smoke");
  git("config", "user.email", "bridge-smoke@example.invalid");
  git("config", "core.autocrlf", "false");
  configure(false);
  git("add", "bridge.config.yaml");
  git("commit", "-qm", "fixture");

  // Exercise opening an actual old task row and adding the nullable column.
  const legacy = new Store(project);
  const oldRun = legacy.createRun("0.11 完成的运行");
  const oldTask = legacy.createTask(oldRun.id, {
    key: "T1", title: "旧任务", description: "", owner: "up", reviewer: null, depends_on: [], paths: [],
    stages: [{ id: "implement", role: "实现", agent: "up", gate: false }],
  }, "done");
  legacy.setRunStatus(oldRun.id, "done");
  legacy.db.exec("ALTER TABLE tasks DROP COLUMN dep_basis");
  legacy.db.close();

  const clients = new Map<string, { client: Client; transport: StreamableHTTPClientTransport }>();
  let daemon: ChildProcess | undefined;
  let log = "";
  const api = async (route: string, body?: object) => {
    const response = await fetch(base + route, body === undefined ? { signal: AbortSignal.timeout(5000) } : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = await response.json();
    assert.ok(response.ok, `${route} ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const invoke = async (client: Client, id: string, name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: { agent_id: id, ...args } });
    const first = (result.content as { type: string; text?: string }[])[0];
    assert.ok(first?.type === "text" && first.text);
    return JSON.parse(first.text);
  };
  const call = async (id: string, name: string, args: Record<string, unknown> = {}) => {
    let connection = clients.get(id);
    if (!connection) {
      const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
      const client = new Client({ name: "stage-deps-smoke", version: "1.0.0" });
      connection = { client, transport };
      clients.set(id, connection);
      await client.connect(transport);
      assert.equal((await invoke(client, id, "join")).agent_id, id);
    }
    return invoke(connection.client, id, name, args);
  };
  const inbox = async (id: string): Promise<MailItem[]> => (await call(id, "fetch_inbox")).mails;
  const turn = (mails: MailItem[]) => mails.find((mail) => mail.kind === "task")?.task;
  const start = async () => {
    log = "";
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/daemon.ts"), "--project", project, "--port", String(port)], {
      cwd: root, env: { ...process.env, BRIDGE_NOTIFY: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    daemon = child;
    child.stdout.on("data", (chunk) => { log += String(chunk); });
    child.stderr.on("data", (chunk) => { log += String(chunk); });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    const until = Date.now() + 12_000;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (log.includes(`:${port}/mcp`)) {
        await api("/api/state");
        return;
      }
      await sleep(80);
    }
    throw new Error(`Stage fixture failed to listen on ${port}\n${log}`);
  };
  const stop = async () => {
    const connections = [...clients.values()];
    clients.clear();
    await Promise.all(connections.map(async ({ client, transport }) => {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }));
    const child = daemon;
    daemon = undefined;
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  };
  const preparePlan = async (title: string) => {
    const { meeting_id: meetingId } = await api("/api/meetings", { topic: title, participants: ["up"] });
    await inbox("up");
    assert.equal((await call("up", "submit_meeting_turn", { meeting_id: meetingId, content: title })).status, "submitted");
    await api(`/api/meetings/${meetingId}/next`, { action: "finalize" });
    await inbox("up");
    return meetingId as number;
  };
  const finalize = (meetingId: number, tasks: unknown[]) => call("up", "submit_meeting_turn", { meeting_id: meetingId, content: "定稿", tasks });
  const approve = (meetingId: number) => api(`/api/meetings/${meetingId}/decide`, { action: "approve" });
  const folder = (meetingId: number) => api(`/api/folders/m${meetingId}`);
  const entry = async (meetingId: number, key: string) => (await folder(meetingId)).tasks.find((item: any) => item.key === key);
  const decide = (id: number, action: "approve" | "reject", note?: string) => api(`/api/attempts/${id}/decide`, { action, note });
  const submit = async (id: string, summary: string, fields: Record<string, unknown> = {}) => {
    const result = await call(id, "submit_handoff", { summary, ...fields });
    assert.equal(result.status, "submitted", JSON.stringify(result));
    return result;
  };

  try {
    await start();
    const old = await api(`/api/folders/r${oldRun.id}`);
    check(old.tasks[0].id === oldTask.id && old.tasks[0].dep_basis === undefined, "0.11 task rows still open after migrating the database");

    const meeting = await preparePlan("阶段依赖");
    const upstream = task("T1", "up", "a.txt", [], "critic");
    const down = task("T2", "down", "b.txt", ["T1@implement"], "cross");
    const invalid: { tasks: unknown[]; problem: RegExp }[] = [
      { tasks: [upstream, { ...down, depends_on: ["T1@", "@implement", "T1@a@b", "T1@implement\n"] }], problem: /格式错误/ },
      { tasks: [upstream, { ...down, depends_on: ["missing@implement"] }], problem: /不在任务清单/ },
      { tasks: [upstream, { ...down, depends_on: ["T2@implement"] }], problem: /指向自己/ },
      { tasks: [upstream, { ...down, depends_on: ["T1@missing"] }], problem: /不存在阶段/ },
      { tasks: [{ ...upstream, reviewer: null }, { ...down, depends_on: ["T1@review"] }], problem: /没有审查人/ },
      { tasks: [upstream, { ...down, depends_on: ["T1", "T1@implement"] }], problem: /重复引用/ },
      { tasks: [{ ...upstream, depends_on: ["T2"] }, down], problem: /成环/ },
      { tasks: [upstream, { ...down, paths: [" ./ "] }], problem: /有效的 paths/ },
      { tasks: [upstream, { ...down, paths: ["*.txt"] }], problem: /文件范围重叠.*a\.txt.*\*\.txt/ },
    ];
    for (const test of invalid) assert.match((await finalize(meeting, test.tasks)).problems.join("\n"), test.problem);
    check(true, "final plans explain every malformed, missing, duplicate, cyclic and overlapping stage dependency");
    assert.equal((await finalize(meeting, [
      upstream, down, task("T3", "late", "c.txt", ["T1@implement"]),
      task("T4", "late", "d.txt", ["T1@review"]), task("T5", "late", "e.txt", ["T1"]),
      task("T6", "guard", "f.txt", ["T1@implement"], "late"),
    ])).status, "submitted");
    assert.equal((await call("guard", "reserve_paths", { globs: ["c.txt"] })).granted, true);
    await approve(meeting);
    assert.equal(turn(await inbox("up")).task.key, "T1");
    assert.equal(turn(await inbox("down")), undefined);
    check((await entry(meeting, "T2")).waiting === "等 T1@implement", "folder and scheduler agree that a missing stage handoff blocks the task");
    write("a.txt", "first\n");
    const first = await submit("up", "接口第一版", { files_changed: ["a.txt"] });
    const downstream = turn(await inbox("down"));
    assert.equal(turn(await inbox("guard")).task.key, "T6");
    const basis = downstream.dependencies[0].based_on;
    check(basis.stage === "implement" && basis.commit === first.commit && Number.isInteger(basis.handoff_id)
      && downstream.upstream_state[0].state === "current", "implementation handoff starts the downstream task with an exact baseline");
    assert.match((await entry(meeting, "T3")).waiting, /等文件租约/);
    assert.equal(turn(await inbox("critic")).stage.id, "review");
    await submit("critic", "接口需改", { verdict: "reject", issues: [{ problem: "返回值约定有误" }] });
    check((await entry(meeting, "T4")).status === "pending" && !(await inbox("down")).length,
      "a rejecting review does not release a stage dependency or announce rework before human confirmation");
    const review = (await entry(meeting, "T1")).live.id;
    await decide(review, "reject", "统一空值语义");
    const rework = (await inbox("down")).filter((mail) => mail.subject === "上游返工：T1@implement → T2");
    check(rework.length === 1 && rework[0].kind === "system" && !rework[0].ack_required
      && rework[0].body?.includes("T1-B1") && rework[0].body.includes("统一空值语义") && !(await inbox("down")).length,
      "human rejection sends one advisory rework mail with the human note and blocking issue");
    await call("guard", "release_paths", { globs: ["c.txt"] });
    check((await entry(meeting, "T3")).waiting === "等 T1@implement" && !(await inbox("late")).length,
      "an unstarted downstream waits for rework even after its lease becomes free");
    assert.equal(turn(await inbox("up")).stage.id, "implement");
    write("b.txt", "consumer\n");
    await submit("down", "使用原计划实现", { files_changed: ["b.txt"] });
    const downstreamReview = turn(await inbox("cross"));
    check(downstreamReview.upstream_state[0].state === "reworking"
      && downstreamReview.dependencies[0].based_on.handoff_id === basis.handoff_id,
      "a review already starting during rework sees the saved baseline and live upstream status");
    await submit("guard", "另一个下游等待审查");

    write("a.txt", "second\n");
    const second = await submit("up", "统一返回值", {
      files_changed: ["a.txt"], addressed: [{ id: "T1-B1", how: "统一空值语义", verified: "覆盖空值" }],
    });
    for (const recipient of ["down", "cross"]) {
      const changes = (await inbox(recipient)).filter((mail) => mail.subject === "上游变更：T1@implement → T2");
      check(changes.length === 1 && !changes[0].ack_required && changes[0].body?.includes(second.commit)
        && changes[0].body.includes(first.commit) && changes[0].body.includes("改动文件 a.txt"),
        `upstream change reaches ${recipient} once with both commits and the changed files`);
      assert.ok(!(await inbox(recipient)).length);
    }
    const waitingReview = await inbox("late");
    const reviewTurn = turn(waitingReview);
    check(reviewTurn.task.key === "T6" && reviewTurn.upstream_state[0].state === "superseded"
      && reviewTurn.upstream_changes[0].commit === second.commit && !waitingReview.some((m) => m.kind === "system"),
      "a reviewer who had not fetched the task sees the update in its first task mail");
    await submit("late", "核对最新基线", { verdict: "approve" });
    const late = turn(await inbox("late"));
    check(late.task.key === "T3" && late.dependencies[0].based_on.commit === second.commit,
      "a downstream that starts after rework uses the new baseline");
    await stop();
    await start();
    const resumed = turn(await inbox("cross"));
    assert.deepEqual(resumed.dependencies[0].based_on, basis);
    check(resumed.resumed && resumed.upstream_state[0].state === "superseded"
      && resumed.input_handoff.based_on === undefined
      && resumed.upstream_changes.length === 1 && resumed.upstream_changes[0].commit === second.commit,
      "re-delivered review after restart carries persistent baseline and changes even after notification was read");
    await submit("cross", "已对照上游新交接", { verdict: "approve" });
    const folderInfo = await folder(meeting);
    const downGate = folderInfo.handoffs.find((h: any) => h.task?.key === "T2" && h.gate);
    check(downGate.gate.upstream_state[0].state === "superseded"
      && downGate.data.based_on[0].dep === "T1@implement" && downGate.data.based_on[0].handoff_id === basis.handoff_id,
      "approval card shows the current upstream state while the review handoff preserves the baseline");
    assert.equal(turn(await inbox("critic")).stage.id, "review");
    await submit("critic", "接口通过", { verdict: "approve", rechecks: [{ id: "T1-B1", status: "fixed" }] });
    check((await entry(meeting, "T4")).status === "active" && (await entry(meeting, "T5")).status === "pending",
      "@review can start after an approving handoff while an old-style dependency still waits for approval");
    await decide((await entry(meeting, "T1")).live.id, "approve");
    assert.equal((await entry(meeting, "T5")).status, "active");
    await api("/api/runs/stop", {});
    const stopped = await folder(meeting);
    check(stopped.run.status === "stopped" && stopped.tasks.filter((t: any) => t.key !== "T1").every((t: any) => t.status === "cancelled")
      && !(await inbox("down")).some((mail) => mail.subject.startsWith("上游取消")),
      "stopping a run cancels its live tasks without notifying downstream work that has also ended");

    const priority = await preparePlan("审查优先与并发提交");
    assert.equal((await finalize(priority, [
      task("P1", "up", "p1.txt"), task("P2", "up", "p2.txt"),
      task("P3", "down", "p3.txt", [], "up"), task("P4", "late", "p4.txt"),
    ])).status, "submitted");
    await approve(priority);
    assert.equal(turn(await inbox("up")).task.key, "P1");
    assert.equal(turn(await inbox("down")).task.key, "P3");
    assert.equal(turn(await inbox("late")).task.key, "P4");
    write("p3.txt", "review candidate\n");
    await submit("down", "等待审查", { files_changed: ["p3.txt"] });
    check(!turn(await inbox("up")), "new ready review does not interrupt an in-progress implementation");
    write("p1.txt", "first work\n");
    write("p4.txt", "independent work\n");
    const [commitA, commitB] = await Promise.all([
      submit("up", "第一份独立交接", { files_changed: ["p1.txt"] }),
      submit("late", "第二份独立交接", { files_changed: ["p4.txt"] }),
    ]);
    check(commitA.commit && commitB.commit && commitA.commit !== commitB.commit
      && git("show", "--pretty=format:", "--name-only", commitA.commit) === "p1.txt"
      && git("show", "--pretty=format:", "--name-only", commitB.commit) === "p4.txt",
      "concurrent handoffs each record their own commit and leased files");
    const chosen = turn(await inbox("up"));
    check(chosen.task.key === "P3" && chosen.stage.id === "review", "review is delivered before an older ready implementation");
    await submit("up", "审查通过", { verdict: "approve" });
    assert.equal(turn(await inbox("up")).task.key, "P2");
    await api("/api/runs/stop", {});

    await stop();
    configure(true);
    await start();
    const gated = await preparePlan("有门实现交接");
    assert.equal((await finalize(gated, [upstream, down])).status, "submitted");
    await approve(gated);
    assert.equal(turn(await inbox("up")).stage.id, "implement");
    const gatedHandoff = await submit("up", "交接没有文件改动");
    const gatedDown = turn(await inbox("down"));
    check(gatedHandoff.commit === null && gatedDown.dependencies[0].based_on.commit === null
      && Number.isInteger(gatedDown.dependencies[0].based_on.handoff_id) && (await entry(gated, "T1")).live.status === "awaiting_approval",
      "an implementation behind an approval gate releases its stage dependency with a handoff ID and null SHA");
    await api("/api/runs/stop", {});
  } catch (error) {
    console.error(`Stage dependency fixture: ${project}\n${log}`);
    throw error;
  } finally {
    await stop();
  }
}
