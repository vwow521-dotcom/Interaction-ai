// Run/task DAG, attempts, and the code committed by each handoff.
import { changedFiles, commitAll, commitPaths, globMatch, normGlob, snapshotChangedFiles } from "../git.js";
import type { Attempt, Feedback, HandoffData, Lease, Mail, Run, Task, TaskStage } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Leases } from "./leases.js";
import { LIVE_MAIL, type Postman } from "./postman.js";
import type { Presence } from "./presence.js";

const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const inGlob = (g: string, f: string) => globMatch(normGlob(g), f);

export class Scheduler {
  private readonly taskWaits = new Map<number, string>(); // task id → why a ready-to-start task hasn't started (lease conflict)
  private readonly committing = new Map<number, Promise<unknown>>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly postman: Postman,
    private readonly leases: Leases,
  ) {
    ctx.store.migrateLegacyRuns(this.pipelineStages());
  }

  taskWait(taskId: number) {
    return this.taskWaits.get(taskId);
  }

  /** A hand-reserved lease may have expired: tasks waiting on it can start now. */
  retryBlockedTasks() {
    const run = this.ctx.store.openRun();
    if (run && this.taskWaits.size) this.schedule(run.id);
  }

  resumeAfterCancellation() {
    const run = this.ctx.store.openRun();
    if (!run) return;
    this.schedule(run.id);
    const agents = this.ctx.store.liveAttempts(run.id).filter((a) => a.status === "ready").map((a) => a.agent);
    for (const agent of new Set(agents)) this.deliver(agent);
  }

  private pipelineStages(): TaskStage[] {
    return this.ctx.cfg.pipeline.map((s) => ({ ...s }));
  }
  private stageOf(task: Task, id: string): TaskStage {
    return task.stages.find((s) => s.id === id) ?? task.stages[0];
  }
  /** Concrete stages for a meeting-planned task: owner/reviewer filled in, reviewer stages dropped when there is none. */
  templateStages(owner: string, reviewer: string | null): TaskStage[] {
    const kept = this.ctx.cfg.task_template.filter((s) => s.agent !== "reviewer" || reviewer);
    const ids = new Set(kept.map((s) => s.id));
    return kept.map((s) => ({
      ...s,
      agent: s.agent === "owner" ? owner : s.agent === "reviewer" ? reviewer! : s.agent,
      on_reject: s.on_reject && ids.has(s.on_reject) ? s.on_reject : undefined,
    }));
  }

  parseFeedback(raw: string | null): Feedback | null {
    if (!raw) return null;
    try {
      const f = JSON.parse(raw);
      if (f && Array.isArray(f.user_requirements)) return f;
    } catch {}
    return { kind: "rework", from_stage: "?", user_requirements: [raw], blocking: [], observations: [] }; // pre-M2b.1 text
  }

  /** "T2 " for runs with several tasks, "" for a plain pipeline run. */
  private taskLabel(task: Task) {
    return this.ctx.store.tasks(task.run_id).length > 1 ? `${task.key} ` : "";
  }

  taskView(t: Task) {
    return { key: t.key, title: t.title, description: t.description, owner: t.owner, reviewer: t.reviewer, depends_on: t.depends_on, paths: t.paths, status: t.status };
  }

  private turnPayload(run: Run, a: Attempt, resumed: boolean): Result {
    const task = this.ctx.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    const all = this.ctx.store.tasks(run.id);
    const multi = all.length > 1;
    const handoffs = this.ctx.store.taskHandoffs(task.id);
    const input = handoffs.at(-1) ?? null;
    const fb = this.parseFeedback(a.feedback);
    const fbGuide: Record<Feedback["kind"], string> = {
      rework:
        "这是一次返工：user_requirements（用户要求）和 blocking（阻塞问题）必须全部完成；observations（非阻塞观察）自行判断，不做也可以。只做这些要求需要的最小改动。",
      approval_note: "用户批准上一阶段时附了要求（user_requirements），请一并满足。",
      carried:
        "本轮是返工后的复审：重点核对 user_requirements 和 blocking 是否都已满足，同时回归原有验收标准。",
    };
    const owned = task.stages.filter((s) => s.owns?.length).map((s) => `${s.id}：${s.owns!.join("、")}`);
    const deps = all.filter((t) => task.depends_on.includes(t.key));
    const meeting = run.meeting_id ? this.ctx.store.meeting(run.meeting_id) : undefined;
    const parallel = all.filter((t) => t.id !== task.id && t.status === "active").map((t) => `${t.key}（${t.owner}）：${t.paths.join("、") || "未声明范围"}`);
    const showTask = multi || !!meeting;
    // A rework's feedback already holds the rejected handoff's review_comments and observations; don't send them twice.
    const fromRejected = fb?.kind === "rework" && input?.stage_id === fb.from_stage;
    const inputData = input && fromRejected ? (({ review_comments: _c, observations: _o, ...rest }) => rest)(input.data) : input?.data;
    // A re-review needs this round's requirements and blocking issues; the previous review's non-blocking notes are its own.
    const feedback = fb?.kind === "carried" ? { ...fb, observations: [] } : fb;
    return {
      resumed,
      run: { id: run.id, goal: run.goal },
      task: showTask ? this.taskView(task) : undefined,
      stage: { id: stage.id, role: stage.role, instructions: stage.instructions ?? null, needs_approval: stage.gate, owns: stage.owns ?? [] },
      feedback,
      input_handoff: input && { from: `${input.agent}/${input.stage_id}`, commit: input.commit_sha, ...inputData },
      earlier_handoffs: handoffs.slice(0, -1).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      dependencies: deps.map((t) => {
        const current = t.status === "active" ? this.ctx.store.taskLiveAttempt(t.id) : undefined;
        const last = this.ctx.store.taskHandoffs(t.id).at(-1);
        return {
          key: t.key, title: t.title, status: t.status,
          stage: current?.stage_id ?? null, stage_status: current?.status ?? null,
          last_handoff_stage: last?.stage_id ?? null, summary: last?.data.summary ?? null, commit: last?.commit_sha ?? null,
          files_changed: last?.data.files_changed ?? [],
        };
      }),
      meeting_minutes: meeting?.doc_path ?? undefined,
      parallel_tasks: parallel.length ? parallel : undefined,
      instructions:
        (resumed ? "这是你之前领到但还没提交的阶段，请继续完成。" : "") +
        `你现在负责${multi ? `任务「${task.key}：${task.title}」的` : ""}阶段「${stage.id}：${stage.role}」。完成后调用 submit_handoff，并在 files_changed 里列全你改动的文件。` +
        (meeting?.doc_path ? "会议纪要见 meeting_minutes，有疑问先读它。" : "") +
        (task.paths.length ? (showTask ? "task.paths 是本任务的文件范围，已为它租下。" : `本任务的文件范围（已为它租下）：${task.paths.join("、")}。`) : "") +
        (fromRejected ? "被打回的那份交接里的审查意见已整理进 feedback，input_handoff 里不再重复。" : "") +
        (parallel.length
          ? "有其他任务在并行：只改本任务范围内的文件；确实要改范围外的文件，先调用 reserve_paths。提交时桥只提交本任务范围内的文件和你在 files_changed 里声明的文件。"
          : "") +
        (fb ? fbGuide[fb.kind] : "") +
        (owned.length ? `文件分工（${owned.join("；")}）：改动其他阶段负责的文件时，请在交接单 notes_for_next 里说明原因。` : "") +
        (stage.on_reject && !stage.instructions?.includes("verdict") ? "这是审查阶段：verdict 填 approve 或 reject；review_comments 只写必须修改的阻塞问题，不影响通过的建议写进 observations。" : ""),
    };
  }

  readTaskMail(m: Mail): Result | null {
    const agent = m.to_agent;
    const a = m.attempt_id ? this.ctx.store.attempt(m.attempt_id) : undefined;
    const run = a && this.ctx.store.run(a.run_id);
    if (!a || !run || !["ready", "in_progress"].includes(a.status) || !["active", "awaiting_approval"].includes(run.status)) return null;
    const resumed = a.status === "in_progress";
    if (!resumed) this.ctx.store.updateAttempt(a.id, { status: "in_progress", started_at: new Date().toISOString() });
    const task = this.ctx.store.task(a.task_id)!;
    this.ctx.log("task_fetched", { agent, run: run.id, task: task.key, stage: a.stage_id, attempt: a.id, resumed, latencyMs: Date.now() - Date.parse(m.created_at) });
    this.ctx.event(run.id, agent, "turn", `${agent} 开始「${this.taskLabel(task)}${a.stage_id}」${resumed ? "（继续）" : ""}`);
    return this.turnPayload(run, this.ctx.store.attempt(a.id)!, resumed);
  }

  /** After a (re)join: re-mail an in-progress task that has no unfetched mail, then deliver the next ready one. */
  resendLiveTask(agent: string) {
    const run = this.ctx.store.openRun();
    if (!run) return;
    for (const a of this.ctx.store.agentAttempts(run.id, agent, ["in_progress"])) {
      const pending = this.ctx.store.taskMailFor(a.id).some((m) => (LIVE_MAIL as readonly string[]).includes(m.status));
      if (!pending) this.sendTaskMail(run.id, a, "（继续）");
    }
    this.deliver(agent);
  }

  private sendTaskMail(run_id: number, a: Attempt, suffix = "") {
    const task = this.ctx.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    this.postman.sendMail({
      run_id,
      attempt_id: a.id,
      from: "bridge",
      to: a.agent,
      kind: "task",
      subject: `任务：${this.taskLabel(task)}${stage.id}（${stage.role}）${suffix}`,
      body: "",
      ack_required: true,
    });
  }

  /** One task at a time per agent: mail its oldest ready attempt once it has nothing in progress or in its inbox. */
  private deliver(agent: string) {
    const run = this.ctx.store.openRun();
    if (!run) return;
    if (this.ctx.store.agentAttempts(run.id, agent, ["in_progress"]).length) return;
    const ready = this.ctx.store.agentAttempts(run.id, agent, ["ready"]);
    if (!ready.length) return;
    const task = this.ctx.store.task(ready[0].task_id)!;
    if (this.leases.cancellationConflict(task)) return;
    const mailed = ready.some((a) => this.ctx.store.taskMailFor(a.id).some((m) => [...LIVE_MAIL, "fetched"].includes(m.status as any)));
    if (!mailed) this.sendTaskMail(run.id, ready[0]);
  }

  startRun(goal: string): Result {
    const busy = this.ctx.guardIdle();
    if (busy) return err(busy);
    const run = this.ctx.store.createRun(goal);
    const stages = this.pipelineStages();
    this.ctx.store.createTask(run.id, { key: "T1", title: goal, description: "", owner: stages[0].agent, reviewer: null, depends_on: [], paths: [], stages });
    this.ctx.log("run_start", { run: run.id, goal });
    this.ctx.event(run.id, null, "run", `任务 #${run.id} 开始：${goal}`);
    this.schedule(run.id);
    return { ok: true, run_id: run.id };
  }

  stopRun(): Result {
    const run = this.ctx.store.openRun();
    if (!run) return err("当前没有进行中的任务。");
    const tasks = new Map(this.ctx.store.tasks(run.id).map((task) => [task.id, task]));
    for (const a of this.ctx.store.attempts(run.id)) {
      const live = ["ready", "in_progress", "awaiting_approval"].includes(a.status);
      if (live) this.ctx.store.updateAttempt(a.id, { status: "cancelled", ended_at: new Date().toISOString() });
      const mails = this.ctx.store.taskMailFor(a.id);
      const unread = live ? mails.filter((m) => [...LIVE_MAIL, "fetched"].some((s) => s === m.status)).map((m) => m.id) : [];
      const acknowledged = mails.filter((m) => m.status === "acked").map((m) => m.id);
      this.holdCancellation(a, tasks.get(a.task_id)!, this.postman.voidMails(unread, acknowledged));
    }
    for (const t of tasks.values()) if (t.status === "pending" || t.status === "active") this.ctx.store.setTaskStatus(t.id, "cancelled");
    this.leases.releaseRun(run.id);
    this.taskWaits.clear();
    this.ctx.store.setRunStatus(run.id, "stopped");
    this.ctx.log("run_stop", { run: run.id });
    this.ctx.event(run.id, null, "run", `任务 #${run.id} 已停止`);
    return { ok: true };
  }

  private holdCancellation(a: Attempt, task: Task, done: Promise<void> | undefined) {
    if (!done) return;
    // An ACP turn can end even while its outstanding MCP handoff is still finishing a Git command.
    const commit = this.committing.get(a.id);
    this.leases.holdForCancellation(task, commit ? Promise.allSettled([done, commit]).then(() => {}) : done);
  }

  /** Start every task whose dependencies are done and whose paths are free; finish the run when all tasks are. */
  schedule(run_id: number) {
    const run = this.ctx.store.run(run_id);
    if (!run || (run.status !== "active" && run.status !== "awaiting_approval")) return;
    const tasks = this.ctx.store.tasks(run_id);
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    let baseline: string[] | undefined;
    for (const t of tasks) {
      if (t.status !== "pending") continue;
      if (!t.depends_on.every((k) => byKey.get(k)?.status === "done")) continue;
      const cancelling = this.leases.cancellationConflict(t);
      const conflicts = cancelling ? [] : this.leases.leaseConflicts(t.paths, { agent: t.owner, taskId: t.id, exclusive: true });
      if (cancelling || conflicts.length) {
        const why = cancelling ? `等 ACP 回合取消：运行 #${cancelling.run_id} 的 ${cancelling.key}`
          : `等文件租约：${conflicts.map((c) => `${c.lease_glob}（${c.held_by}${c.task ? "/" + c.task : ""}）`).join("、")}`;
        if (this.taskWaits.get(t.id) !== why) this.ctx.event(run_id, null, "lease", `${t.key} ${why}`);
        this.taskWaits.set(t.id, why);
        continue;
      }
      this.taskWaits.delete(t.id);
      baseline ??= snapshotChangedFiles(this.ctx.cfg.projectDir);
      this.ctx.store.recordTaskBaseline(t.id, baseline);
      this.ctx.store.setTaskStatus(t.id, "active");
      t.status = "active";
      this.leases.leaseTaskPaths(t);
      if (tasks.length > 1) this.ctx.event(run_id, null, "task", `${t.key}「${t.title}」开始（${t.owner}）`);
      this.ctx.log("task_start", { run: run_id, task: t.key, owner: t.owner, paths: t.paths });
      this.assign(run, t, t.stages[0], null);
    }
    const left = this.ctx.store.tasks(run_id).filter((t) => t.status === "pending" || t.status === "active");
    if (!left.length) {
      this.ctx.store.setRunStatus(run_id, "done");
      this.taskWaits.clear();
      this.ctx.log("run_done", { run: run_id });
      this.ctx.event(run_id, null, "run", `任务 #${run_id} 完成`);
      this.ctx.notifyHuman("协作桥：任务完成", `#${run_id} ${run.goal}`);
      return;
    }
    this.refreshRunStatus(run_id);
  }

  /** awaiting_approval when everything live is waiting at a gate, otherwise active. */
  private refreshRunStatus(run_id: number) {
    const run = this.ctx.store.run(run_id);
    if (!run || (run.status !== "active" && run.status !== "awaiting_approval")) return;
    const live = this.ctx.store.liveAttempts(run_id);
    const next = live.length && live.every((a) => a.status === "awaiting_approval") ? "awaiting_approval" : "active";
    if (next !== run.status) this.ctx.store.setRunStatus(run_id, next);
  }

  private assign(run: Run, task: Task, stage: TaskStage, feedback: Feedback | null) {
    const a = this.ctx.store.createAttempt(run.id, task.id, stage.id, stage.agent, feedback ? JSON.stringify(feedback) : null);
    this.ctx.log("stage_assigned", { run: run.id, task: task.key, stage: stage.id, agent: stage.agent, attempt: a.id, agentStatus: this.presence.status(stage.agent) });
    this.deliver(stage.agent);
    this.refreshRunStatus(run.id);
  }

  private advance(run: Run, task: Task, fromStage: string, feedback: Feedback | null) {
    const i = task.stages.findIndex((s) => s.id === fromStage);
    const next = task.stages[i + 1];
    if (next) return this.assign(run, task, next, feedback);
    this.ctx.store.setTaskStatus(task.id, "done");
    this.ctx.store.releaseLeasesOfTask(task.id);
    this.ctx.log("task_done", { run: run.id, task: task.key });
    if (this.ctx.store.tasks(run.id).length > 1) this.ctx.event(run.id, null, "task", `${task.key}「${task.title}」完成`);
    this.schedule(run.id);
  }

  /** Decide what the handoff commits and what to tell the human about scope. */
  private async scopeAndCommit(run: Run, task: Task, attempt: Attempt, stage: TaskStage, agent: string, data: HandoffData) {
    const changed = await changedFiles(this.ctx.cfg.projectDir);
    const declared = new Set(data.files_changed.map(norm));
    const tasks = this.ctx.store.tasks(run.id);
    const parallel = new Map(tasks.filter((t) => t.id !== task.id && t.status === "active").map((t) => [t.id, t]));
    const review = !!data.verdict || stage.id === "review";
    const leases = this.leases.activeLeases();
    const mine = (l: Lease) => l.task_id === task.id || (l.agent === agent && (l.task_id === null || l.task_id === task.id));
    const otherLeases = leases.filter((l) => !mine(l));
    const ownGlobs = [...task.paths, ...leases.filter(mine).map((l) => l.glob)];
    const holderOf = (f: string) => otherLeases.find((l) => inGlob(l.glob, f));
    const scope_notes: string[] = [];

    let toCommit: string[] | null = null; // legacy unscoped pipeline handoff
    let considered = changed;
    if (parallel.size || ownGlobs.length || review) {
      const baseline = new Set(this.ctx.store.taskBaseline(task.id));
      const taken: string[] = [];
      const outside: string[] = [];
      const preexisting: string[] = [];
      const parallelChanges: string[] = [];
      toCommit = [];
      for (const f of changed) {
        const holder = holderOf(f);
        const declaredHere = declared.has(norm(f));
        const ownsIt = declaredHere || (!review && ownGlobs.some((g) => inGlob(g, f)));
        if (!holder && ownsIt) {
          toCommit.push(f);
          continue;
        }
        const otherTask = holder?.task_id == null ? undefined : parallel.get(holder.task_id);
        if (baseline.has(f)) {
          preexisting.push(holder && declaredHere ? `${f}（已声明，由 ${holder.agent} 租用）` : f);
        } else if (holder && otherTask) {
          parallelChanges.push(`${f}（${holder.agent}/${otherTask.key}${declaredHere ? "，交接单已声明" : ""}）`);
        } else if (holder) {
          if (declaredHere) taken.push(`${f}（${holder.agent}${holder.task_id ? "/" + this.ctx.store.task(holder.task_id)?.key : ""}）`);
        } else outside.push(f);
      }
      considered = toCommit;
      if (preexisting.length) scope_notes.push(`开工前就有的未提交改动，本次交接未纳入：${preexisting.join("、")}`);
      if (parallelChanges.length) scope_notes.push(`其他任务进行中的改动，本次交接未纳入：${parallelChanges.join("、")}`);
      if (taken.length) scope_notes.push(`声明的文件属于其他任务的租约，没有提交：${taken.join("、")}`);
      if (outside.length) {
        const why = review ? "审查交接未声明这些改动" : "改动不在本任务范围、也没在交接单里声明";
        scope_notes.push(`${why}，没有提交：${outside.join("、")}`);
      }
    }
    const undeclared = data.files_changed.length ? considered.filter((f) => !declared.has(norm(f))) : [];
    if (undeclared.length) scope_notes.push(`改动了但没在交接单里声明：${undeclared.join("、")}`);
    for (const other of task.stages) {
      if (other.id === stage.id || !other.owns?.length || stage.owns?.some((g) => other.owns!.includes(g))) continue;
      const hit = considered.filter((f) => other.owns!.some((g) => globMatch(g, f)) && !stage.owns?.some((g) => globMatch(g, f)));
      if (hit.length) scope_notes.push(`改动了「${other.id}」阶段负责的文件：${hit.join("、")}`);
    }

    let commit_sha: string | null = null;
    let commit_error: string | null = null;
    if (this.ctx.cfg.git.auto_commit && this.ctx.store.attempt(attempt.id)?.status === "in_progress") {
      const multi = tasks.length > 1;
      const verdictText = data.verdict === "approve" ? "审查通过 — " : data.verdict === "reject" ? "审查打回 — " : "";
      const subject = `[bridge] ${multi ? task.key + " " : ""}${stage.id} by ${agent}: ${verdictText}${data.summary}`.slice(0, 120);
      const bodyParts = [`run #${run.id}: ${run.goal}`];
      if (multi) bodyParts.push(`task ${task.key}: ${task.title}`);
      if (data.review_comments?.length) bodyParts.push("阻塞问题：\n- " + data.review_comments.join("\n- "));
      if (data.observations?.length) bodyParts.push("观察：\n- " + data.observations.join("\n- "));
      if (data.notes_for_next) bodyParts.push(data.notes_for_next);
      if (scope_notes.length) bodyParts.push("范围提示：\n- " + scope_notes.join("\n- "));
      const body = bodyParts.join("\n\n").slice(0, 6000);
      const allowEmpty = !!data.verdict && this.ctx.cfg.git.commit_reviews;
      const r = toCommit
        ? await commitPaths(this.ctx.cfg.projectDir, toCommit.map((f) => `:(top,literal)${f}`), subject, body, { allowEmpty })
        : await commitAll(this.ctx.cfg.projectDir, subject, body, { allowEmpty });
      if ("sha" in r) commit_sha = r.sha;
      else if ("error" in r) commit_error = r.error;
      else commit_error = `未提交：${r.skipped}`;
    }
    return { commit_sha, commit_error, scope_notes, scoped: !!toCommit };
  }

  async submitHandoff(agent: string, sessionId: string | undefined, data: HandoffData, taskKey?: string): Promise<Result> {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.ctx.store.openRun();
    const mineNow = run ? this.ctx.store.agentAttempts(run.id, agent, ["in_progress"]) : [];
    const a = taskKey ? mineNow.find((x) => this.ctx.store.task(x.task_id)?.key === taskKey) : mineNow[0];
    if (!run || !a)
      return err(
        taskKey && mineNow.length
          ? `你正在进行的任务里没有「${taskKey}」。`
          : "当前没有分配给你、正在进行的阶段，不能提交。请先调用 fetch_inbox 看有没有任务信。",
      );
    const task = this.ctx.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    if (this.committing.has(a.id)) return err("这个阶段的交接正在提交。");
    const commit = this.scopeAndCommit(run, task, a, stage, agent, data);
    this.committing.set(a.id, commit);
    const { commit_sha, commit_error, scope_notes } = await commit.finally(() => this.committing.delete(a.id));
    if (this.ctx.store.attempt(a.id)?.status !== "in_progress") return err("这个阶段已停止或被替换，交接未推进流程。");

    const h = this.ctx.store.addHandoff({ run_id: run.id, attempt_id: a.id, stage_id: stage.id, agent, data, commit_sha, commit_error, scope_notes });
    const label = this.taskLabel(task);
    if (scope_notes.length) this.ctx.event(run.id, agent, "scope", `「${label}${stage.id}」交接的范围提示：${scope_notes.join("；")}`);
    this.ctx.store.setMailStatus(this.ctx.store.taskMailFor(a.id).filter((m) => m.status !== "void").map((m) => m.id), "acked");
    const ended = new Date().toISOString();
    this.presence.markReturned(agent);
    this.ctx.log("handoff", { run: run.id, task: task.key, stage: stage.id, agent, summary: data.summary, verdict: data.verdict, commit: commit_sha, commitError: commit_error });
    this.ctx.event(run.id, agent, "handoff", `${agent} 完成「${label}${stage.id}」：${data.summary}`);

    const after = this.presence.doorbellKind(agent) === "poll" ? "立即调用 wait_for_mail 等信。" : "可以结束本回合了，有新信时会叫醒你。";
    if (stage.gate) {
      this.ctx.store.updateAttempt(a.id, { status: "awaiting_approval", handoff_id: h.id, ended_at: ended });
      this.refreshRunStatus(run.id);
      this.ctx.event(run.id, null, "gate", `「${label}${stage.id}」等待你在面板上审批`);
      this.ctx.notifyHuman("协作桥：等你审批", `${agent} 完成了「${label}${stage.id}」：${data.summary}`);
      this.deliver(agent);
      return { status: "submitted", commit: commit_sha, commit_note: commit_error, scope_notes, next: "等待用户在面板上审批", instructions: "已提交。" + after };
    }
    this.ctx.store.updateAttempt(a.id, { status: "done", handoff_id: h.id, ended_at: ended });
    // A rework round's requirements travel on, so the next reviewer knows what this round was for.
    const fb = this.parseFeedback(a.feedback);
    this.advance(run, task, stage.id, fb && fb.kind !== "approval_note" ? { ...fb, kind: "carried" } : null);
    this.deliver(agent);
    const nextLive = this.ctx.store.taskLiveAttempt(task.id);
    const runNow = this.ctx.store.run(run.id)!;
    return {
      status: "submitted",
      commit: commit_sha,
      commit_note: commit_error,
      scope_notes,
      next: nextLive ? `${nextLive.agent}/${nextLive.stage_id}` : runNow.status === "done" ? "任务完成" : `${task.key} 完成`,
      instructions: "已交接。" + after,
    };
  }

  decide(attemptId: number, action: "approve" | "reject", note: string): Result {
    const a = this.ctx.store.attempt(attemptId);
    if (!a || a.status !== "awaiting_approval") return err("这个阶段不在等待审批。");
    const run = this.ctx.store.run(a.run_id)!;
    const task = this.ctx.store.task(a.task_id)!;
    const stage = this.stageOf(task, a.stage_id);
    const label = this.taskLabel(task);
    const h = a.handoff_id ? this.ctx.store.handoff(a.handoff_id) : undefined;
    const trimmed = note.trim();
    this.ctx.store.updateAttempt(a.id, { status: action === "approve" ? "approved" : "rejected", decided_note: trimmed || null });
    this.ctx.log("gate_decision", { run: run.id, task: task.key, stage: stage.id, attempt: a.id, action, note: trimmed });

    if (action === "approve") {
      this.ctx.event(run.id, null, "gate", `你批准了「${label}${stage.id}」${trimmed ? "：" + trimmed : ""}`);
      this.advance(
        run,
        task,
        stage.id,
        trimmed ? { kind: "approval_note", from_stage: stage.id, user_requirements: [trimmed], blocking: [], observations: [] } : null,
      );
    } else {
      this.holdCancellation(a, task, this.postman.cancelAcpMail(this.ctx.store.taskMailFor(a.id).map((m) => m.id)));
      const target = this.stageOf(task, stage.on_reject ?? stage.id);
      const comments = h?.data.review_comments ?? [];
      const rejected = h?.data.verdict === "reject";
      // Review comments are blocking only when the reviewer itself rejected; otherwise they are observations.
      const fb: Feedback = {
        kind: "rework",
        from_stage: stage.id,
        user_requirements: trimmed ? [trimmed] : [],
        blocking: rejected ? comments : [],
        observations: [...(rejected ? [] : comments), ...(h?.data.observations ?? [])],
      };
      this.ctx.event(run.id, null, "gate", `你打回了「${label}${stage.id}」→「${target.id}」${trimmed ? "：" + trimmed : ""}`);
      this.assign(run, task, target, fb);
    }
    this.refreshRunStatus(run.id);
    return { ok: true };
  }

  currentTask(agent: string): Task | undefined {
    const run = this.ctx.store.openRun();
    if (!run) return undefined;
    const a = this.ctx.store.agentAttempts(run.id, agent, ["in_progress"])[0] ?? this.ctx.store.agentAttempts(run.id, agent, ["ready", "awaiting_approval"])[0];
    return a ? this.ctx.store.task(a.task_id) : undefined;
  }
}
