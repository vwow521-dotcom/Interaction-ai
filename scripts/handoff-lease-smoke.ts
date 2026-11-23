import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import YAML from "yaml";
import { globMatch, globsOverlap } from "../src/git.js";

interface Fixture {
  startDaemon(project: string): Promise<void>;
  stopDaemon(): Promise<void>;
  connect(name: string): Promise<Client>;
  call(client: Client, name: string, args: Record<string, unknown>): Promise<any>;
  api(route: string, body?: object): Promise<{ status: number; json: any }>;
}

export async function smokeHandoffLeases({ startDaemon, stopDaemon, connect, call, api }: Fixture) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-handoff-leases-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
  const glob = "src/**/index.ts";
  const files = ["src/index.ts", "src/a/b/index.ts", "src/tools/myindex.ts"];
  git("init", "-q");
  git("config", "user.name", "bridge-smoke");
  git("config", "user.email", "bridge-smoke@example.invalid");
  git("config", "core.hooksPath", ".git/hooks");
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: { owner: { doorbell: "poll" }, reviewer: { doorbell: "poll" }, downstream: { doorbell: "poll" } },
    pipeline: [{ id: "implement", role: "实现", agent: "owner" }, { id: "review", role: "审查", agent: "reviewer" }],
    notify: { enabled: false },
  }));
  git("add", "bridge.config.yaml");
  git("commit", "-qm", "fixture");
  const clients: Client[] = [];
  try {
    await startDaemon(project);
    async function member(id: string) {
      const client = await connect(id);
      clients.push(client);
      const invoke = (name: string, args = {}) => call(client, name, { agent_id: id, ...args });
      await invoke("join");
      return invoke;
    }
    const owner = await member("owner");
    const reviewer = await member("reviewer");
    const state = async () => (await api("/api/state")).json;
    const downstream = await member("downstream");
    const reserve = (exclusive: boolean) => ({ globs: [glob], exclusive });
    await owner("reserve_paths", reserve(false));
    await reviewer("reserve_paths", reserve(false));
    assert.equal((await owner("reserve_paths", reserve(true))).granted, false);
    await reviewer("release_paths");
    assert.equal((await owner("reserve_paths", reserve(true))).leases[0].exclusive, true);
    assert.equal((await reviewer("reserve_paths", reserve(false))).granted, false);
    assert.equal((await owner("reserve_paths", reserve(false))).leases[0].exclusive, false);
    assert.equal((await reviewer("reserve_paths", reserve(false))).granted, true);
    await reviewer("release_paths");
    console.log("ok   lease upgrades and downgrades enforce the mode reported to both members");
    await owner("release_paths");
    const participants = ["owner", "reviewer", "downstream"];
    const meeting = (await api("/api/meetings", { topic: "交接失败重试", participants })).json.meeting_id;
    await owner("fetch_inbox");
    assert.equal((await owner("submit_meeting_turn", { meeting_id: meeting, content: "建议分两个任务" })).status, "submitted");
    assert.equal((await api(`/api/meetings/${meeting}/next`, { action: "finalize" })).status, 200);
    await owner("fetch_inbox");
    const plan = await owner("submit_meeting_turn", { meeting_id: meeting, content: "验证阶段依赖", tasks: [
      { id: "T1", title: "上游", owner: "owner", reviewer: "reviewer", paths: [glob], depends_on: [] },
      { id: "T2", title: "下游", owner: "downstream", paths: ["down.txt"], depends_on: ["T1@implement"] },
    ] });
    assert.equal(plan.status, "submitted", JSON.stringify(plan));
    assert.equal((await api(`/api/meetings/${meeting}/decide`, { action: "approve" })).status, 200);
    await owner("fetch_inbox");
    for (const [i, file] of files.entries()) {
      assert.equal(globMatch(glob, file), i < 2);
      assert.equal(globsOverlap(glob, file), i < 2);
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), file);
    }
    const hook = path.join(project, ".git/hooks/pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho fixture-hook-failed >&2\nexit 1\n", { mode: 0o755 });
    const submit = () => owner("submit_handoff", { summary: "目录范围回归" });
    assert.match((await submit()).error, /fixture-hook-failed/);
    const failed = await state();
    assert.equal(failed.live.status, "in_progress");
    assert.equal(failed.handoffs.length, 0);
    assert.equal(failed.mail.find((m: any) => m.kind === "task" && m.to === "owner").status, "fetched");
    assert.equal(failed.mail.some((m: any) => m.kind === "task" && m.to !== "owner"), false);
    fs.unlinkSync(hook);
    assert.equal((await submit()).status, "submitted");
    assert.equal((await state()).handoffs.length, 1);
    assert.ok((await reviewer("fetch_inbox")).mails.some((m: any) => m.kind === "task"));
    assert.ok((await downstream("fetch_inbox")).mails.some((m: any) => m.task?.task?.key === "T2"));
    console.log("ok   failed commit retains the assignment and retry delivers one handoff");
    assert.deepEqual(git("diff", "--name-only", "HEAD^", "HEAD").split(/\r?\n/).sort(), files.slice(0, 2).sort());
    console.log("ok   scoped handoff commits only complete directory glob matches");
    const skipped = await downstream("submit_handoff", { summary: "无文件改动" });
    assert.equal(skipped.status, "submitted");
    assert.match(skipped.commit_note, /没有文件改动/);
    console.log("ok   an unchanged scoped task still advances with a skip reason");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopDaemon();
  }
}
