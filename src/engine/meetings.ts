// Meeting rounds, plan validation and approval into a run.
import fs from "node:fs";
import path from "node:path";
import { commitPaths, globsOverlap, normGlob } from "../git.js";
import type { Mail, Meeting, MeetingTurnKind, PlannedTask } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import { previewPlan, type PlanPreview } from "./plan-preview.js";
import { LIVE_MAIL, type Postman } from "./postman.js";
import type { Presence } from "./presence.js";
import type { Scheduler } from "./scheduler.js";
import { parseDependency } from "./stage-deps.js";

export const KIND_LABEL: Record<MeetingTurnKind, string> = { proposal: "提案", critique: "互评", final: "定稿" };
const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });

export function summarizeTurn(content: string) {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((text) => !/^#{1,6}\s/.test(text)) ?? lines[0] ?? "";
  const prose = line.replace(/^(?:[-*+>]|#{1,6}|\d+[.)])\s+/, "");
  const sentence = sentences.segment(prose)[Symbol.iterator]().next().value?.segment.trim() ?? "";
  const characters = [...sentence];
  return characters.length <= 160 ? sentence : characters.slice(0, 159).join("") + "…";
}

export class Meetings {
  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly postman: Postman,
    private readonly scheduler: Scheduler,
  ) {}

  private meetingMailId(meetingId: number, round: number, agent: string) {
    return `meeting-${meetingId}-${round}-${agent}`;
  }
  private meetingMailRef(id: string) {
    const m = /^meeting-(\d+)-(\d+)-(.+)$/.exec(id);
    return m ? { meeting: Number(m[1]), round: Number(m[2]), agent: m[3] } : null;
  }
  expectedSpeakers(m: Meeting) {
    return m.round_kind === "final" ? [m.facilitator] : m.participants;
  }

  private meetingPayload(m: Meeting, agent: string): Result {
    const turns = this.ctx.store.meetingTurns(m.id);
    const rounds: Result[] = [];
    // The agent's own last turn is already in its conversation, unless that conversation started after the turn
    // (a new session, a takeover, a rejoin, a restarted background member): then it gets the full text like everyone else's.
    const since = this.presence.conversationSince(agent);
    const remembers = (t: { agent: string; created_at: string }) => t.agent === agent && since !== undefined && since <= Date.parse(t.created_at);
    let ownSummarized = false;
    for (let r = 1; r < m.round; r++) {
      const ts = turns.filter((t) => t.round === r);
      if (!ts.length) continue;
      rounds.push({
        round: r,
        kind: ts[0].kind,
        turns: ts.map((t) => {
          if (r !== m.round - 1) return { agent: t.agent, summary: summarizeTurn(t.content) };
          if (remembers(t)) {
            ownSummarized = true;
            return { agent: t.agent, yours: true, summary: summarizeTurn(t.content) };
          }
          return { agent: t.agent, content: t.content, tasks: t.tasks ?? undefined, decisions: t.decisions.length ? t.decisions : undefined, preview: t.preview };
        }),
      });
    }
    const taskSpec =
      "tasks 是任务清单，每项：id（如 T1）、title、description（要做什么、验收标准）、owner（负责人，可选：" +
      this.presence.agentIds().join("、") +
      "）、reviewer（审查人，可选，留空则不审查）、" +
      "depends_on（T1 等整项完成，T1@implement 等该阶段的合格交接；阶段须在上游实际存在，同一上游只写一项，依赖不能成环。阶段依赖双方都要声明互不重叠的 paths）、" +
      "paths（预计改动的文件 glob，例如 src/ui/**；桥按它分配文件租约）。";
    const guide: Record<MeetingTurnKind, string> = {
      proposal:
        "这是第 1 轮：提案。独立给出你的方案：思路、关键决策和理由、风险。可以附一份任务拆分草案（tasks，可选）。先读项目代码再提案，不要改任何文件。",
      critique:
        "这是互评轮。逐条评价上一轮各方（包括你自己）的方案：同意什么、反对什么、为什么，以及你修正后的立场。不要改任何文件。",
      final:
        "这是定稿轮，由你负责。综合各轮讨论写出最终方案（content）、关键决策（decisions，每项 what + why）和任务清单（tasks，必填）。" +
        "分配负责人时参考 members[].notes。" +
        "两位主力尽量各领一个可同时开工的实现任务，并交叉审查。有先后关系的用 depends_on 表示，尽量让可并行的任务文件范围互不重叠。不要改任何文件。",
    };
    const planning = m.round_kind === "proposal" || m.round_kind === "final";
    return {
      meeting_id: m.id,
      topic: m.topic,
      round: m.round,
      kind: m.round_kind,
      participants: m.participants,
      ...(planning ? {
        members: Object.entries(this.ctx.cfg.agents).map(([id, { product, notes }]) => ({
          id, product: product ?? null, notes: notes || null,
        })),
      } : {}),
      facilitator: m.facilitator,
      you: agent,
      human_note: m.round_note ?? undefined,
      previous_rounds: rounds,
      meeting_minutes: m.doc_path ?? undefined,
      instructions:
        guide[m.round_kind] +
        (m.round_note ? "用户对本轮的要求见 human_note，必须回应。" : "") +
        (ownSummarized ? "previous_rounds 里标 yours 的是你自己上一轮的发言，只给摘要，全文就在你这段对话里。" : "") +
        (planning ? taskSpec : "") +
        `写完后调用 submit_meeting_turn(agent_id, meeting_id=${m.id}, content${m.round_kind === "final" ? ", decisions, tasks" : m.round_kind === "proposal" ? ", tasks?" : ""})。`,
    };
  }

  readMeetingMail(m: Mail): Result | null {
    const ref = this.meetingMailRef(m.id);
    const mt = ref && this.ctx.store.meeting(ref.meeting);
    if (!ref || !mt || mt.status !== "collecting" || mt.round !== ref.round) return null;
    return this.meetingPayload(mt, m.to_agent);
  }

  private sendRoundMail(m: Meeting) {
    for (const agent of this.expectedSpeakers(m))
      this.postman.sendMail({
        id: this.meetingMailId(m.id, m.round, agent),
        from: "bridge",
        to: agent,
        kind: "meeting",
        subject: `会议「${m.topic.slice(0, 30)}」第 ${m.round} 轮：${KIND_LABEL[m.round_kind]}`,
        body: "",
        ack_required: true,
      });
  }

  private voidRoundMail(m: Meeting) {
    const open = this.ctx.store.mailWithPrefix(`meeting-${m.id}-`).filter((x) => [...LIVE_MAIL, "fetched"].includes(x.status as any));
    this.postman.voidMails(open.map((x) => x.id));
  }

  startMeeting(topic: string, participants?: string[], facilitator?: string): Result {
    const t = topic.trim();
    if (!t) return err("议题不能为空。");
    const busy = this.ctx.guardIdle();
    if (busy) return err(busy);
    const parts = participants?.length ? [...new Set(participants)] : this.presence.agentIds();
    const bad = parts.filter((p) => !this.presence.isAgent(p));
    if (bad.length) return err(`未知成员：${bad.join("、")}`);
    const fac = facilitator || this.ctx.cfg.meetings.facilitator || parts[0];
    if (!this.presence.isAgent(fac)) return err(`未知主持人：${fac}`);
    if (!parts.includes(fac)) parts.push(fac);
    const m = this.ctx.store.createMeeting(t, parts, fac);
    this.ctx.log("meeting_start", { meeting: m.id, topic: t, participants: parts, facilitator: fac });
    this.ctx.event(null, null, "meeting", `会议 #${m.id} 开始：${t}（${parts.join("、")}，定稿：${fac}）`, m.id);
    this.sendRoundMail(m);
    return { ok: true, meeting_id: m.id };
  }

  /** Problems with a planned task list; empty = fine. */
  validatePlan(tasks: PlannedTask[]): string[] {
    const errs: string[] = [];
    if (!tasks.length) errs.push("tasks 不能为空。");
    const byId = new Map<string, PlannedTask>();
    for (const t of tasks) {
      if (!/^[\w-]+$/.test(t.id ?? "")) errs.push(`任务 id「${t.id}」只能包含字母、数字、_ 和 -。`);
      if (byId.has(t.id)) errs.push(`任务 id 重复：${t.id}`);
      byId.set(t.id, t);
      if (!t.title?.trim()) errs.push(`${t.id}：title 不能为空。`);
      if (!this.presence.isAgent(t.owner)) errs.push(`${t.id}：owner「${t.owner}」不是成员（可选：${this.presence.agentIds().join("、")}）。`);
      if (t.reviewer && !this.presence.isAgent(t.reviewer)) errs.push(`${t.id}：reviewer「${t.reviewer}」不是成员。`);
      if (!this.scheduler.templateStages(t.owner, t.reviewer ?? null).length)
        errs.push(`${t.id}：任务模板没有可执行的阶段，请指定审查人或调整任务模板。`);
    }
    const graph = new Map<string, string[]>();
    for (const task of tasks) {
      const edges: string[] = [];
      graph.set(task.id, edges);
      for (const dep of task.depends_on ?? []) {
        const ref = parseDependency(dep);
        const label = `${task.id} 的依赖「${dep}」`;
        if (!ref) {
          errs.push(`${label}格式错误，应写任务 ID 或任务ID@阶段ID。`);
          continue;
        }
        if (ref.key === task.id) {
          errs.push(`${label}指向自己。`);
          continue;
        }
        const upstream = byId.get(ref.key);
        if (!upstream) {
          errs.push(`${label}引用的任务「${ref.key}」不在任务清单里。`);
          continue;
        }
        if (edges.includes(ref.key)) {
          errs.push(`${label}重复引用上游「${ref.key}」。`);
          continue;
        }
        edges.push(ref.key);
        if (ref.stage) this.validateStageDependency(label, ref.stage, task, upstream, errs);
      }
    }
    // Cycle check (DFS).
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): boolean => {
      if (state.get(id) === 2) return false;
      if (state.get(id) === 1) {
        errs.push(`依赖成环：${[...trail, id].join(" → ")}`);
        return true;
      }
      state.set(id, 1);
      for (const d of graph.get(id) ?? []) if (graph.has(d) && visit(d, [...trail, id])) return true;
      state.set(id, 2);
      return false;
    };
    for (const id of graph.keys()) if (visit(id, [])) break;
    return errs;
  }

  private validateStageDependency(label: string, stage: string, task: PlannedTask, upstream: PlannedTask, errs: string[]) {
    const stages = this.scheduler.templateStages(upstream.owner, upstream.reviewer ?? null).map((s) => s.id);
    if (!stages.includes(stage)) {
      const missingReviewer = !upstream.reviewer && this.ctx.cfg.task_template.some((s) => s.agent === "reviewer" && s.id === stage);
      const reason = missingReviewer ? `${upstream.id} 没有审查人，模板移除了阶段「${stage}」` : `上游不存在阶段「${stage}」`;
      errs.push(`${label}：${reason}。可选阶段：${stages.join("、") || "无"}。`);
    }
    const from = (upstream.paths ?? []).map(normGlob).filter(Boolean);
    const to = (task.paths ?? []).map(normGlob).filter(Boolean);
    if (!from.length || !to.length) {
      errs.push(`${label}要求上下游都声明有效的 paths。`);
      return;
    }
    const conflicts = from.flatMap((a) => to.filter((b) => globsOverlap(a, b)).map((b) => `「${a}」与「${b}」`));
    if (conflicts.length) errs.push(`${label}的上下游文件范围重叠：${conflicts.join("、")}。`);
  }

  submitMeetingTurn(
    agent: string,
    sessionId: string | undefined,
    meetingId: number,
    content: string,
    tasks?: PlannedTask[],
    decisions: { what: string; why: string }[] = [],
  ): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const m = this.ctx.store.meeting(meetingId);
    if (!m) return err(`会议 #${meetingId} 不存在。`);
    if (m.status !== "collecting") return err(`会议 #${m.id} 现在不收发言（状态：${m.status}）。`);
    if (!this.expectedSpeakers(m).includes(agent)) return err(`第 ${m.round} 轮（${KIND_LABEL[m.round_kind]}）不需要你发言。`);
    const turns = this.ctx.store.meetingTurns(m.id);
    if (turns.some((t) => t.round === m.round && t.agent === agent)) return err(`第 ${m.round} 轮你已经发过言了。`);
    if (!content.trim()) return err("content 不能为空。");
    const planned = tasks?.map((t) => ({ ...t, depends_on: t.depends_on ?? [], paths: t.paths ?? [], description: t.description ?? "", reviewer: t.reviewer || null }));
    let preview: PlanPreview | undefined;
    if (m.round_kind === "final") {
      const plan = planned ?? [];
      const problems = this.validatePlan(plan);
      if (problems.length) return { error: "任务清单有问题，请修改后重新提交。", problems };
      preview = previewPlan(plan, (t) => this.scheduler.templateStages(t.owner, t.reviewer ?? null), m.participants);
    }
    this.ctx.store.addMeetingTurn({ meeting_id: m.id, round: m.round, kind: m.round_kind, agent, content: content.trim(), tasks: planned ?? null, decisions, preview });
    this.ctx.store.setMailStatus([this.meetingMailId(m.id, m.round, agent)], "acked");
    this.presence.markReturned(agent);
    this.ctx.log("meeting_turn", { meeting: m.id, round: m.round, kind: m.round_kind, agent, tasks: planned?.length ?? 0 });
    this.ctx.event(null, agent, "meeting", `${agent} 在会议 #${m.id} 第 ${m.round} 轮${KIND_LABEL[m.round_kind]}发言`, m.id);

    const spoken = new Set([...turns.filter((t) => t.round === m.round).map((t) => t.agent), agent]);
    const complete = this.expectedSpeakers(m).every((a) => spoken.has(a));
    if (complete) {
      if (m.round_kind === "final") {
        this.ctx.store.updateMeeting(m.id, { status: "awaiting_approval" });
        this.ctx.event(null, null, "meeting", `会议 #${m.id} 定稿完成，等你批准`, m.id);
        this.ctx.notifyHuman("协作桥：会议定稿等你批准", `${m.topic}（${planned?.length ?? 0} 个任务）`);
      } else {
        this.ctx.store.updateMeeting(m.id, { status: "review" });
        this.ctx.event(null, null, "meeting", `会议 #${m.id} 第 ${m.round} 轮发言已齐，等你决定：再互评一轮或定稿`, m.id);
        this.ctx.notifyHuman("协作桥：会议发言已齐", `${m.topic} 第 ${m.round} 轮`);
      }
    }
    const after = this.presence.doorbellKind(agent) === "poll" ? "立即调用 wait_for_mail 等信。" : "可以结束本回合了，下一轮开始时会叫醒你。";
    return { status: "submitted", round: m.round, waiting_for: this.expectedSpeakers(m).filter((a) => !spoken.has(a)), preview, instructions: "已发言。" + after };
  }

  /** Human: open the next round (another critique, or the final plan). Allowed while some are still silent. */
  meetingNext(meetingId: number, action: "critique" | "finalize", note: string): Result {
    const m = this.ctx.store.meeting(meetingId);
    if (!m || !["collecting", "review"].includes(m.status)) return err("这个会议现在不能进入下一轮。");
    if (m.round_kind === "final") return err("已经在定稿了。");
    const turns = this.ctx.store.meetingTurns(m.id).filter((t) => t.round === m.round);
    if (!turns.length) return err("本轮还没有任何人发言。");
    this.voidRoundMail(m);
    const kind: MeetingTurnKind = action === "critique" ? "critique" : "final";
    this.ctx.store.updateMeeting(m.id, { status: "collecting", round: m.round + 1, round_kind: kind, round_note: note.trim() || null });
    const next = this.ctx.store.meeting(m.id)!;
    this.ctx.log("meeting_round", { meeting: m.id, round: next.round, kind });
    this.ctx.event(null, null, "meeting", `会议 #${m.id} 进入第 ${next.round} 轮：${KIND_LABEL[kind]}${note.trim() ? "（你的意见：" + note.trim() + "）" : ""}`, m.id);
    this.sendRoundMail(next);
    return { ok: true, round: next.round };
  }

  meetingCancel(meetingId: number): Result {
    const m = this.ctx.store.meeting(meetingId);
    if (!m || !["collecting", "review", "awaiting_approval"].includes(m.status)) return err("这个会议已经结束。");
    this.voidRoundMail(m);
    this.ctx.store.updateMeeting(m.id, { status: "cancelled" });
    this.ctx.log("meeting_cancel", { meeting: m.id });
    this.ctx.event(null, null, "meeting", `会议 #${m.id} 已取消`, m.id);
    return { ok: true };
  }

  /** Human: approve the final plan (minutes → git, tasks → a run) or send it back to the facilitator. */
  async meetingDecide(meetingId: number, action: "approve" | "reject", note: string): Promise<Result> {
    const m = this.ctx.store.meeting(meetingId);
    if (!m || m.status !== "awaiting_approval") return err("这个会议不在等待批准。");
    const trimmed = note.trim();
    if (action === "reject") {
      this.ctx.store.updateMeeting(m.id, { status: "collecting", round: m.round + 1, round_kind: "final", round_note: trimmed || "用户要求修改定稿。" });
      this.ctx.event(null, null, "meeting", `你打回了会议 #${m.id} 的定稿${trimmed ? "：" + trimmed : ""}`, m.id);
      this.sendRoundMail(this.ctx.store.meeting(m.id)!);
      return { ok: true };
    }
    if (this.ctx.store.openRun()) return err("已有任务在进行中，先停止它再批准。");
    const final = this.ctx.store.meetingTurns(m.id).filter((t) => t.kind === "final").at(-1);
    if (!final?.tasks?.length) return err("定稿里没有任务清单。");

    const rel = this.minutesPath(m);
    const abs = path.join(this.ctx.cfg.projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, this.minutes(m, final.tasks, final.content, final.decisions, trimmed));
    let commit: string | null = null;
    let commit_note: string | null = null;
    if (this.ctx.cfg.git.auto_commit) {
      const r = await commitPaths(this.ctx.cfg.projectDir, [`:(literal)${rel}`], `[bridge] 会议纪要：${m.topic}`.slice(0, 120), `meeting #${m.id}，${final.tasks.length} 个任务`);
      if ("sha" in r) commit = r.sha;
      else commit_note = "error" in r ? r.error : r.skipped;
    }

    const run = this.ctx.store.createRun(m.topic, m.id);
    for (const t of final.tasks)
      this.ctx.store.createTask(run.id, {
        key: t.id,
        title: t.title,
        description: t.description + (trimmed ? `\n\n用户批准会议定稿时的要求：${trimmed}` : ""),
        owner: t.owner,
        reviewer: t.reviewer || null,
        depends_on: t.depends_on,
        paths: t.paths.map(normGlob),
        stages: this.scheduler.templateStages(t.owner, t.reviewer || null),
      });
    this.ctx.store.updateMeeting(m.id, { status: "done", run_id: run.id, doc_path: rel });
    this.ctx.log("meeting_approved", { meeting: m.id, run: run.id, doc: rel, commit, tasks: final.tasks.length });
    this.ctx.event(run.id, null, "meeting", `你批准了会议 #${m.id} 的定稿：纪要 ${rel}，${final.tasks.length} 个任务开始分派`, m.id);
    this.ctx.event(run.id, null, "run", `任务 #${run.id} 开始：${m.topic}`);
    this.scheduler.schedule(run.id);
    return { ok: true, run_id: run.id, doc_path: rel, commit, commit_note };
  }

  private minutesPath(m: Meeting) {
    const day = new Date().toISOString().slice(0, 10);
    const topic = m.topic.replace(/[\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'<>＂＇\u2460-\u249b\u24ea-\u24ff\u2776-\u2793]/gu, "");
    // A dot between digits is part of a version number ("0.9.0"), not the end of the short title.
    const head = topic.split(/(?<!\d)\.|\.(?!\d)|[^\P{P}.]|[|*\u0000-\u001f]/u, 1)[0].trim().replace(/\s+/g, "-");
    const slug = [...head].slice(0, 24).join("").replace(/-+$/, "");
    const dir = this.ctx.cfg.meetings.dir.replace(/\\/g, "/").replace(/\/+$/, "");
    const stem = `${dir}/${day}-m${m.id}${slug ? "-" + slug : ""}`;
    let rel = `${stem}.md`;
    for (let suffix = 2; fs.existsSync(path.join(this.ctx.cfg.projectDir, rel)); suffix++) rel = `${stem}-${suffix}.md`;
    return rel;
  }

  private minutes(m: Meeting, tasks: PlannedTask[], finalContent: string, decisions: { what: string; why: string }[], note: string) {
    const turns = this.ctx.store.meetingTurns(m.id);
    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const L: string[] = [
      `# 会议纪要：${m.topic}`,
      "",
      `- 日期：${new Date().toISOString().slice(0, 10)}`,
      `- 参与：${m.participants.join("、")}（定稿：${m.facilitator}）`,
      `- 会议编号：#${m.id}`,
      "",
      "## 议题",
      "",
      m.topic,
      "",
    ];
    const rounds = [...new Set(turns.map((t) => t.round))].sort((a, b) => a - b);
    for (const r of rounds) {
      const ts = turns.filter((t) => t.round === r);
      if (ts[0].kind === "final" && r === rounds.at(-1)) continue; // the adopted final is written below
      L.push(`## 第 ${r} 轮：${KIND_LABEL[ts[0].kind]}`, "");
      for (const t of ts) {
        L.push(`### ${t.agent}`, "", t.content, "");
        if (t.tasks?.length) L.push("任务草案：" + t.tasks.map((x) => `${x.id} ${x.title}（${x.owner}）`).join("；"), "");
      }
    }
    L.push("## 定稿", "", finalContent, "");
    if (decisions.length) L.push("### 关键决策", "", ...decisions.map((d) => `- ${d.what} —— ${d.why}`), "");
    L.push("## 你的决定", "", "批准。" + (note ? note : ""), "");
    L.push("## 任务清单", "", "| 编号 | 任务 | 负责 | 审查 | 依赖 | 文件范围 |", "|---|---|---|---|---|---|");
    for (const t of tasks)
      L.push(`| ${t.id} | ${cell(t.title)} | ${t.owner} | ${t.reviewer || "—"} | ${t.depends_on.join("、") || "—"} | ${cell(t.paths.join("、")) || "—"} |`);
    L.push("");
    for (const t of tasks) L.push(`### ${t.id} ${t.title}`, "", t.description || "（无描述）", "");
    return L.join("\n");
  }
}
