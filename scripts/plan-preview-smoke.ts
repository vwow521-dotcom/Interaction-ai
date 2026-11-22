import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import YAML from "yaml";
import { previewPlan, type PlanPreview } from "../src/engine/plan-preview.js";
import { Store, type PlannedTask, type TaskStage } from "../src/store.js";

interface Fixture {
  root: string;
  base: string;
  startDaemon(project: string): Promise<void>;
  stopDaemon(): Promise<void>;
  api(path: string, body?: object): Promise<{ status: number; json: any }>;
  call(client: Client, name: string, args: Record<string, unknown>): Promise<any>;
  check(ok: unknown, message: string): void;
}

const agents = ["alice", "bob", "cara"];
const who = agents.slice(0, 2);
const planned = (id: string, owner: string, reviewer?: string, depends_on: string[] = [], paths = [id + ".txt"]): PlannedTask => ({
  id, title: id, description: "", owner, reviewer, depends_on, paths,
});

function stages(task: PlannedTask): TaskStage[] {
  const rows: TaskStage[] = [{ id: "implement", role: "实现", agent: task.owner, gate: false }];
  if (task.reviewer) rows.push({ id: "review", role: "审查", agent: task.reviewer, gate: true, on_reject: "implement" });
  return rows;
}

function hintCodes(preview: PlanPreview) {
  return preview.hints.map(({ code }) => code);
}

function waves(preview: PlanPreview) {
  return preview.waves.map(({ items }) => items.map(({ task, stage, agent }) => `${task}@${stage} ${agent}`));
}

export async function smokePlanPreview({ root, base, startDaemon, stopDaemon, api, call, check }: Fixture) {
  console.log("\nMeeting parallelism preview");
  const estimate = (plan: PlannedTask[]) => previewPlan(plan, stages, who);
  const oneCoder = [planned("A", "alice", "bob"), planned("B", "alice", "bob")];
  const one = estimate(oneCoder);
  assert.deepEqual(hintCodes(one), ["single_coder", "owner_queue"]);
  assert.deepEqual(one.members, [{ agent: "alice", work: 2, review: 0 }, { agent: "bob", work: 0, review: 2 }]);
  assert.equal(one.total_units, 3);
  assert.deepEqual(hintCodes(estimate(oneCoder.slice(0, 1))), []);
  assert.ok(!hintCodes(previewPlan(oneCoder, stages, ["alice"])).includes("single_coder"));
  check(true, "the estimate counts members and only flags a single coder with two tasks and a review-only participant");

  const chain = [planned("A", "alice"), planned("B", "bob", undefined, ["A"]), planned("C", "alice", undefined, ["B@implement"])];
  assert.deepEqual(hintCodes(estimate(chain)), ["serial_chain"]);
  assert.deepEqual(hintCodes(estimate(chain.slice(0, 2))), []);
  assert.deepEqual(waves(estimate(chain)), [["A@implement alice"], ["B@implement bob"], ["C@implement alice"]]);
  check(true, "a serial chain of at least three tasks counts references to a task's last stage as full dependencies");

  const parallelPlan = [planned("A", "alice"), planned("B", "alice"), planned("C", "bob"), planned("D", "bob")];
  const parallel = estimate(parallelPlan);
  assert.deepEqual(waves(parallel), [["A@implement alice", "C@implement bob"], ["B@implement alice", "D@implement bob"]]);
  assert.deepEqual(hintCodes(parallel), []);
  assert.deepEqual(estimate(parallelPlan), parallel);
  const differentStarts = estimate([
    planned("A", "bob"), planned("B", "bob", undefined, ["A"]),
    planned("C", "alice", undefined, ["A"]), planned("D", "alice", undefined, ["B"]),
  ]);
  assert.ok(!hintCodes(differentStarts).includes("owner_queue"));
  check(true, "two occupied members and implementations that become ready at different times avoid queue hints");

  const stageChain = estimate([
    planned("A", "alice", "bob"), planned("B", "cara", "alice", ["A@implement"]), planned("C", "bob", undefined, ["B@implement"]),
  ]);
  assert.deepEqual(waves(stageChain), [["A@implement alice"], ["A@review bob", "B@implement cara"], ["B@review alice", "C@implement bob"]]);
  assert.deepEqual(hintCodes(stageChain), []);
  const priority = estimate([planned("B", "bob", undefined, ["A@implement"]), planned("A", "alice", "bob")]);
  assert.deepEqual(waves(priority), [["A@implement alice"], ["A@review bob"], ["B@implement bob"]]);
  check(true, "early dependencies overlap with later upstream stages and a review wins simultaneous readiness");

  const leaseOwner = planned("A", "alice", "cara", [], ["./src/"]);
  const leaseWaiter = planned("B", "bob", undefined, [], ["src\\one.ts"]);
  const conflict = estimate([leaseOwner, leaseWaiter]);
  assert.deepEqual(hintCodes(conflict), ["path_serialized"]);
  assert.match(conflict.hints[0].text, /B 等 A.*src\/one\.ts.*src\/\*\*/);
  assert.deepEqual(waves(conflict), [["A@implement alice"], ["A@review cara"], ["B@implement bob"]]);
  assert.deepEqual(hintCodes(estimate([leaseOwner, { ...leaseWaiter, depends_on: ["A"] }])), []);
  check(true, "lease hints name the conflict, hold through review and stay absent if dependencies already serialize the tasks");

  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-plan-preview-"));
  execFileSync("git", ["init", "-q", project]);
  const configure = (template?: object[]) => fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: Object.fromEntries(agents.map((id) => [id, { doorbell: "poll" }])),
    pipeline: [{ id: "implement", role: "实现", agent: "alice" }],
    task_template: template,
    git: { auto_commit: false }, notify: { enabled: false },
  }));
  configure();
  const legacy = new Store(project);
  const old = legacy.createMeeting("旧定稿", who, "alice");
  legacy.addMeetingTurn({ meeting_id: old.id, round: 1, kind: "final", agent: "alice", content: "旧版计划", tasks: oneCoder, decisions: [] });
  legacy.updateMeeting(old.id, { status: "done", round_kind: "final" });
  legacy.db.exec("ALTER TABLE meeting_turns DROP COLUMN preview");
  legacy.db.close();

  const cards = await import(pathToFileURL(path.join(root, "panel/js/cards/round.js")).href);
  const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
  const closeClients = async () => {
    for (const { client, transport } of clients.splice(0)) {
      if (transport.sessionId) await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  };
  const connect = async (id: string) => {
    const client = new Client({ name: "preview-smoke", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
    clients.push({ client, transport });
    await client.connect(transport);
    assert.equal((await call(client, "join", { agent_id: id })).agent_id, id);
    return (name: string, args: Record<string, unknown> = {}) => call(client, name, { ...args, agent_id: id });
  };
  const json = async (url: string, body?: object) => {
    const res = await api(url, body);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json;
  };
  const prepare = async (submit: Awaited<ReturnType<typeof connect>>, topic: string) => {
    const { meeting_id: id } = await json("/api/meetings", { topic, participants: who });
    await submit("fetch_inbox");
    const proposal = await submit("submit_meeting_turn", { meeting_id: id, content: "草案", tasks: oneCoder });
    assert.equal(proposal.status, "submitted");
    assert.equal(proposal.preview, undefined);
    await json(`/api/meetings/${id}/next`, { action: "finalize" });
    const instructions = (await submit("fetch_inbox")).mails.find((mail: any) => mail.kind === "meeting").meeting.instructions;
    assert.match(instructions, /交叉审查/);
    assert.match(instructions, /T1@implement/);
    return id as number;
  };

  try {
    await startDaemon(project);
    const oldRound = (await json(`/api/folders/m${old.id}`)).rounds[0];
    assert.equal(oldRound.turns[0].preview, undefined);
    assert.match(cards.speakersFor(oldRound, who, true), /旧版计划/);
    assert.doesNotMatch(cards.speakersFor(oldRound, who, true), /并行预览/);
    const alice = await connect("alice");
    const id = await prepare(alice, "并行预览");
    const finish = (tasks: PlannedTask[]) => alice("submit_meeting_turn", { meeting_id: id, content: "定稿", tasks });
    const first = await finish(oneCoder);
    assert.equal(first.status, "submitted");
    assert.deepEqual(first.preview, one);
    const snapshot = await json("/api/state");
    assert.ok(snapshot.inbox.some((item: any) => item.kind === "meeting_final" && item.ref.meeting_id === id));
    const inboxRound = snapshot.timeline.find((item: any) => item.type === "round" && item.meeting_id === id && item.round === first.round);
    assert.deepEqual(inboxRound.turns[0].preview, first.preview);
    const approval = cards.roundCard(inboxRound, who, { showSpeakers: false });
    assert.match(approval.body, /并行预览.*仅提示.*第 1 波/);
    assert.match(approval.body, /bob（实现 0，审查 2）/);
    assert.match(approval.control.buttons, /批准定稿并分派/);
    check(true, "hints do not block submission and the approval inbox renders waves, member counts and the same persisted hints");

    await json(`/api/meetings/${id}/decide`, { action: "reject", note: "用阶段依赖调整分工" });
    await alice("fetch_inbox");
    const second = await finish([planned("A", "alice", "cara"), planned("B", "bob", undefined, ["A@implement"])]);
    assert.equal(second.status, "submitted");
    assert.deepEqual(waves(second.preview), [["A@implement alice"], ["A@review cara", "B@implement bob"]]);
    const approved = await json(`/api/meetings/${id}/decide`, { action: "approve" });
    const bob = await connect("bob");
    assert.ok(!(await bob("fetch_inbox")).mails.some((m: any) => m.kind === "task"));
    assert.ok((await alice("fetch_inbox")).mails.some((m: any) => m.task?.task?.key === "A"));
    assert.equal((await alice("submit_handoff", { summary: "接口初稿" })).status, "submitted");
    const work = (await bob("fetch_inbox")).mails.find((m: any) => m.kind === "task");
    assert.equal(work.task.task.key, "B");
    assert.equal(work.task.run.id, approved.run_id);
    await json("/api/runs/stop", {});
    check(true, "the preview of a stage-dependent plan matches the live early dispatch after approval");

    await closeClients();
    await stopDaemon();
    configure([{ id: "verify", role: "核验", agent: "reviewer" }]);
    await startDaemon(project);
    const reopened = await json(`/api/folders/m${id}?round=${first.round}`);
    const history = reopened.rounds.find((round: any) => round.round === first.round);
    const latest = reopened.rounds.find((round: any) => round.round === second.round);
    assert.equal(history.full, true);
    assert.deepEqual(history.turns[0].preview, one);
    assert.deepEqual(latest.turns[0].preview, second.preview);
    assert.match(cards.speakersFor(history, who, true), /并行预览.*仅提示/);
    const summary = (await json(`/api/folders/m${id}`)).rounds.find((round: any) => round.round === first.round);
    assert.equal(summary.full, false);
    assert.equal(summary.turns[0].preview, undefined);
    check(true, "historical previews survive migration, restart and template changes without bloating summary payloads");

    const planner = await connect("alice");
    const altered = await prepare(planner, "新模板");
    const final = (tasks: PlannedTask[]) => planner("submit_meeting_turn", { meeting_id: altered, content: "新定稿", tasks });
    const noStages = await final([planned("A", "alice")]);
    assert.match(noStages.problems.join("\n"), /没有可执行的阶段/);
    const withReviewer = await final([planned("A", "alice", "bob")]);
    assert.equal(withReviewer.status, "submitted");
    assert.deepEqual(waves(withReviewer.preview), [["A@verify bob"]]);
    check(true, "a task with no effective stage is rejected, and the preview uses the current expanded template when stages exist");
  } finally {
    await closeClients();
    await stopDaemon();
  }
}
