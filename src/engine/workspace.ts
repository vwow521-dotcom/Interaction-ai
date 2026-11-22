// Project context, progress, notes, questions and the panel's read model.
import type { Doorbells } from "../doorbells/index.js";
import { activityFor } from "./activity.js";
import type { Chat } from "./chat.js";
import type { DeliveryNotice, Room } from "./room.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Diagnostics } from "./diagnostics.js";
import { Folders, isOpenRun, taskStates, type FolderCursor } from "./folders.js";
import type { Leases } from "./leases.js";
import type { Meetings } from "./meetings.js";
import { LIVE_MAIL, type Postman } from "./postman.js";
import type { Presence } from "./presence.js";
import type { Scheduler } from "./scheduler.js";

export class Workspace {
  private readonly folders: Folders;

  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly postman: Postman,
    private readonly scheduler: Scheduler,
    private readonly leases: Leases,
    private readonly meetings: Meetings,
    private readonly chat: Chat,
    private readonly room: Room,
    private readonly doorbells: Doorbells,
    private readonly diagnostics: Diagnostics,
  ) {
    this.folders = new Folders(ctx, meetings, room, scheduler);
  }

  getContext(agent: string, sessionId: string | undefined, lastN = 3): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.ctx.store.openRun();
    const tasks = run ? this.ctx.store.tasks(run.id) : [];
    const task = this.scheduler.currentTask(agent);
    const handoffs = task ? this.ctx.store.taskHandoffs(task.id) : run ? this.ctx.store.handoffs(run.id) : [];
    const n = Math.max(0, Math.min(lastN, handoffs.length));
    const live = run ? (this.ctx.store.agentAttempts(run.id, agent, ["in_progress", "ready", "awaiting_approval"])[0] ?? this.ctx.store.liveAttempt(run.id)) : undefined;
    const meeting = run?.meeting_id ? this.ctx.store.meeting(run.meeting_id) : this.ctx.store.openMeeting();
    const keyOf = (id: number) => tasks.find((t) => t.id === id)?.key;
    return {
      run: run ? { id: run.id, goal: run.goal, status: run.status } : null,
      current_task: task ? this.scheduler.taskView(task) : null,
      current_round: live ? { task: keyOf(live.task_id), stage: live.stage_id, agent: live.agent, status: live.status, feedback: this.scheduler.parseFeedback(live.feedback) } : null,
      tasks: tasks.length > 1 ? tasks.map((t) => ({ ...this.scheduler.taskView(t), description: undefined, stage: this.ctx.store.taskLiveAttempt(t.id)?.stage_id ?? null, waiting: this.scheduler.taskWait(t.id) })) : undefined,
      stages: run ? this.ctx.store.attempts(run.id).map((a) => ({ task: keyOf(a.task_id), stage: a.stage_id, agent: a.agent, status: a.status, gate_note: a.decided_note })) : [],
      handoffs_total: handoffs.length,
      older_handoffs: handoffs.slice(0, handoffs.length - n).map((h) => `${h.agent}/${h.stage_id}：${h.data.summary}`),
      recent_handoffs: handoffs.slice(handoffs.length - n).map((h) => ({ from: `${h.agent}/${h.stage_id}`, commit: h.commit_sha, at: h.created_at, ...h.data })),
      leases: this.leases.activeLeases().map((l) => ({ glob: l.glob, agent: l.agent, task: l.task_id ? keyOf(l.task_id) ?? null : null, exclusive: !!l.exclusive, expires_at: l.expires_at })),
      meeting: meeting ? { id: meeting.id, topic: meeting.topic, status: meeting.status, minutes: meeting.doc_path } : null,
      notes: this.ctx.store.notes().map((x) => ({ topic: x.topic, by: x.agent, text: x.text, at: x.created_at })),
      chat: this.chat.history(10),
      project_dir: this.ctx.cfg.projectDir,
    };
  }

  reportProgress(agent: string, sessionId: string | undefined, text: string, busyMinutes?: number): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.ctx.store.openRun();
    let busyUntil: number | undefined;
    if (busyMinutes !== undefined) {
      if (!Number.isInteger(busyMinutes) || busyMinutes < 1 || busyMinutes > 60) return err("busy_minutes 必须是 1 到 60 的整数分钟。");
      const attempt = run && this.ctx.store.agentAttempts(run.id, agent, ["in_progress"])[0];
      if (!attempt) return err("busy_minutes 只能在你领取了任务、正在进行某个阶段时使用。这次汇报没有记录，请去掉 busy_minutes 再汇报。");
      busyUntil = this.presence.setBusy(agent, attempt.id, busyMinutes);
    } else this.presence.clearBusy(agent);
    const until = busyUntil === undefined ? undefined : new Date(busyUntil).toISOString();
    this.ctx.log("progress", { agent, text, busyUntil: until });
    this.ctx.event(run?.id ?? null, agent, "progress", text + (busyMinutes ? `（执行长命令，预计 ${busyMinutes} 分钟）` : ""));
    return until ? { ok: true, busy_until: until } : { ok: true };
  }

  postNote(agent: string, sessionId: string | undefined, topic: string, text: string): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const run = this.ctx.store.openRun();
    const id = this.ctx.store.addNote(run?.id ?? null, agent, topic, text);
    this.ctx.event(run?.id ?? null, agent, "note", `[${topic}] ${text}`);
    return { ok: true, note_id: id };
  }

  readNotes(agent: string, sessionId: string | undefined, topic?: string): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    return { notes: this.ctx.store.notes(topic).map((n) => ({ topic: n.topic, by: n.agent, text: n.text, at: n.created_at })) };
  }

  /** Non-blocking: the answer arrives later as mail, so nobody sits polling for it. */
  askHuman(agent: string, sessionId: string | undefined, question: string): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    if (!question.trim()) return err("问题不能为空。");
    const run = this.ctx.store.openRun();
    const id = this.ctx.store.addQuestion(run?.id ?? null, agent, question.trim());
    this.ctx.log("ask_human", { agent, question_id: id, question });
    this.ctx.event(run?.id ?? null, agent, "question", `${agent} 提问：${question}`);
    this.ctx.notifyHuman(`协作桥：${agent} 问你`, question);
    return {
      status: "submitted",
      question_id: id,
      instructions:
        "问题已出现在用户的面板上，答复会以信件送达。能先做的部分先做；需要等答复时" +
        (this.presence.doorbellKind(agent) === "poll" ? "调用 wait_for_mail。" : "直接结束本回合，答复到达时会叫醒你。"),
    };
  }

  answer(questionId: number, answer: string): Result {
    const q = this.ctx.store.question(questionId);
    if (!q || q.answer !== null) return err("问题不存在或已回答。");
    this.ctx.store.answerQuestion(questionId, answer);
    this.ctx.log("human_answer", { question_id: questionId });
    this.ctx.event(q.run_id, null, "answer", `你回答了 ${q.agent}：${answer}`);
    this.postman.sendMail({
      id: `answer-${questionId}`,
      run_id: q.run_id,
      from: "human",
      to: q.agent,
      kind: "answer",
      subject: `用户回答了你的问题 #${questionId}`,
      body: `你的问题：${q.question}\n用户的回答：${answer}`,
      importance: "high",
    });
    return { ok: true };
  }

  snapshot() {
    const panel = this.readPanel();
    const { nowPlaying, needs } = this.folderState(panel);
    return { ...panel, folders_head: this.folders.page(8, needs).folders, now_playing: nowPlaying };
  }

  folderPage(limit: number, before?: FolderCursor) {
    const { needs } = this.folderState(this.readPanel());
    return this.folders.page(limit, needs, before);
  }

  folderDetail(id: string, round?: number, handoffsBefore?: number) {
    const { needs } = this.folderState(this.readPanel());
    return this.folders.detail(id, needs.get(id) ?? 0, round, handoffsBefore);
  }

  private folderState(panel: ReturnType<Workspace["readPanel"]>) {
    const nowPlaying = this.folders.nowPlaying(panel.run, panel.tasks, panel.lives, panel.meeting);
    const needs = this.folders.needs(panel.inbox, panel.timeline, panel.questions, nowPlaying);
    return { nowPlaying, needs };
  }

  private readPanel() {
    const run = this.ctx.store.openRun() ?? this.ctx.store.recentRuns(1)[0];
    const attempts = run ? this.ctx.store.attempts(run.id) : [];
    const live = run ? this.ctx.store.liveAttempt(run.id) : undefined;
    const lives = run ? this.ctx.store.liveAttempts(run.id) : [];
    const handoffs = run ? this.ctx.store.handoffs(run.id) : [];
    const tasks = run ? this.ctx.store.tasks(run.id) : [];
    const keyOf = (id: number | null) => (id ? tasks.find((t) => t.id === id)?.key ?? null : null);
    const runOpen = isOpenRun(run);
    const waitingForTurn = new Set<string>();
    const openMeeting = this.ctx.store.openMeeting();
    const meeting = openMeeting ?? this.ctx.store.recentMeetings(1)[0];
    const turns = meeting ? this.ctx.store.meetingTurns(meeting.id) : [];
    const expected = meeting ? this.meetings.expectedSpeakers(meeting) : [];
    const spokenNow = turns.filter((t) => t.round === meeting?.round).map((t) => t.agent);
    const roundMail = openMeeting?.status === "collecting"
      ? this.ctx.store.mailWithPrefix(`meeting-${openMeeting.id}-${openMeeting.round}-`).filter((m) => m.kind === "meeting") : [];
    const deliveries = new Map<string, DeliveryNotice>();
    const diagnoses = this.diagnostics.notices();
    const agents = this.presence.agentIds().map((id) => {
      const p = this.presence.get(id)!;
      const product = this.diagnostics.product(id, p.client);
      const acp = this.doorbells.acp.snapshot(id);
      const doorbellStats = this.doorbells.stats(id);
      const failedWake = doorbellStats.find((stat) => stat.consecutiveFailures > 0);
      const status = this.presence.status(id);
      const lastSeenAt = p.lastSeenAt ? new Date(Math.max(p.lastSeenAt, p.lastReturnAt ?? 0)).toISOString() : null;
      const active = runOpen ? lives.filter((a) => a.agent === id) : [];
      const next = active.find((a) => a.status === "ready" || a.status === "in_progress");
      const owesTurn = openMeeting?.status === "collecting" && expected.includes(id) && !spokenNow.includes(id);
      const pending = this.ctx.store.mailByStatus(id, [...LIVE_MAIL]);
      const waiting = this.postman.isBusy(id) ? pending.filter((m) => m.status === "rung") : [];
      for (const m of waiting) waitingForTurn.add(m.id);
      const unacked = this.ctx.store.mailByStatus(id, ["fetched"]).filter((m) => m.ack_required);
      const stuck = pending.filter((m) => m.status === "stuck");
      const unanswered = pending.filter((m) => !waitingForTurn.has(m.id) && this.postman.isUnanswered(m.id));
      let delivery: DeliveryNotice | undefined;
      if (stuck.length) {
        delivery = {
          reason: "stuck", agent: id, at: stuck[0].created_at, title: `${id} 有 ${stuck.length} 封信送不到`,
          message: `${id} 没有响应门铃，有 ${stuck.length} 封信送不到。请在 ${id} 里说「继续」。`,
        };
      } else if (unanswered.length) {
        delivery = {
          reason: "unanswered", agent: id, at: unanswered[0].created_at, title: `${id} 叫不醒，有 ${unanswered.length} 封信没取`,
          message: `${id} 叫不醒，有 ${unanswered.length} 封信没取（对话可能已关闭或断开）。请打开它的对话说一句「继续」。`,
        };
      } else if (next && status === "never-joined" && (!acp || !this.doorbells.sessionless(id))) {
        delivery = {
          reason: status, agent: id, at: next.assigned_at, title: `${id} 有任务，等待加入`,
          message: `轮到 ${id}，但它还没有加入协作桥。请在 ${id} 里粘贴启动提示词。`,
        };
      } else if (next && status === "offline" && !this.doorbells.sessionless(id)) {
        delivery = {
          reason: status, agent: id, at: next.assigned_at, title: `${id} 有任务，当前离线`,
          message: `轮到 ${id}，但它不在线。请在 ${id} 里说「继续」。`,
        };
      }
      if (delivery) deliveries.set(id, delivery);
      return {
        id,
        notes: this.ctx.cfg.agents[id].notes || null,
        roles: this.presence.rolesOf(id),
        // What it is on right now: live stages of the open run, and a meeting turn it still owes.
        doing: [
          ...active.map((a) => ({ task: tasks.length > 1 ? keyOf(a.task_id) : null, stage: a.stage_id, status: a.status })),
          ...(owesTurn
            ? [{ task: null, stage: `会议第 ${openMeeting.round} 轮`, status: "meeting" }]
            : []),
        ],
        status,
        product,
        doorbellStats,
        acp,
        diagnostics: diagnoses.filter((d) => d.agent === id || (d.agent === null && d.product === product?.id)),
        activity: activityFor({
          id, status, lastSeen: lastSeenAt,
          attempts: active, tasks, handoffs, template: this.ctx.cfg.task_template, delivery,
          failedWake, acpActivity: acp?.activity, busy: this.presence.busy(id),
          meeting: owesTurn ? {
            meeting: openMeeting, invitedAt: roundMail.find((m) => m.to_agent === id)?.created_at ?? (openMeeting.round === 1 ? openMeeting.created_at : null),
          } : undefined,
        }),
        doorbell: this.presence.doorbellKind(id),
        doorbellLabel: this.doorbells.get(this.presence.doorbellKind(id)).label,
        doorbellChain: this.doorbells.chain(id),
        doorbellArmed: this.presence.doorbellArmed(id),
        lastRingVia: p.lastRingKind ? this.doorbells.get(p.lastRingKind).label : null,
        doorbellError: p.doorbellError ?? null,
        binding: p.sessionId
          ? {
              session: p.sessionId.slice(0, 8),
              since: p.boundAt ? new Date(p.boundAt).toISOString() : null,
              open: this.presence.isSessionOpen(p.sessionId),
              autoReleaseAt: p.lastSeenAt ? new Date(p.lastSeenAt + this.ctx.cfg.wait.offline_after_seconds * 1000).toISOString() : null,
            }
          : null,
        pendingMail: pending.length,
        stuckMail: stuck.length,
        waitingForTurn: waiting.length,
        unansweredMail: unanswered.length,
        unackedMail: unacked.length,
        waitCalls: p.waitCalls,
        lastSeenAt,
        lastRingAt: p.lastRingAt ? new Date(p.lastRingAt).toISOString() : null,
      };
    });
    // Keep the legacy banner's priorities while exposing all delivery issues in the inbox.
    let attention: { kind: "fallback" | "stale"; agent: string; message: string } | null = null;
    const notices = [...deliveries.values()];
    const mailNotice = notices.find((d) => d.reason === "stuck") ?? notices.find((d) => d.reason === "unanswered");
    if (mailNotice) attention = { kind: "fallback", agent: mailNotice.agent, message: mailNotice.message };
    else if (runOpen)
      for (const l of lives) {
        if (l.status !== "ready" && l.status !== "in_progress") continue;
        const delivery = deliveries.get(l.agent);
        if (delivery) attention = { kind: "fallback", agent: l.agent, message: delivery.message };
        else if (agents.find((a) => a.id === l.agent)?.status === "stale")
          attention = { kind: "stale", agent: l.agent, message: `${l.agent} 一段时间没有响应，可能是网络波动，正在等它恢复。` };
        if (attention) break;
      }
    const questions = this.ctx.store.openQuestions();
    const timeline = this.room.timeline(questions, notices, diagnoses, run?.id, meeting?.id);
    const now = Date.now();
    return {
      project: this.ctx.cfg.projectDir,
      configSource: this.ctx.cfg.source,
      pipeline: this.ctx.cfg.pipeline.map((s) => ({ id: s.id, role: s.role, agent: s.agent, gate: s.gate, on_reject: s.on_reject ?? null })),
      run: run ?? null,
      attempts,
      live: live ?? null,
      lives,
      tasks: taskStates(tasks, attempts, this.scheduler),
      leases: this.ctx.store.openLeases().map((l) => ({ ...l, task: keyOf(l.task_id), expired: !!l.expires_at && Date.parse(l.expires_at) <= now })),
      meeting: meeting
        ? {
            ...meeting,
            expected,
            turns,
          }
        : null,
      handoffs,
      agents,
      attention,
      questions,
      mail: this.ctx.store.recentMail(25).map((m) => ({
        id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, subject: m.subject, status: m.status,
        ring_count: m.ring_count, created_at: m.created_at, overdue: !!m.overdue_flagged, waitingForTurn: waitingForTurn.has(m.id),
      })),
      chat: this.chat.recent(50, (a) => this.postman.isBusy(a)),
      timeline,
      inbox: this.room.inbox(timeline),
      endpoints: this.ctx.store.endpoints(),
      notes: this.ctx.store.notes().slice(-20).reverse(),
      events: this.ctx.store.recentEvents(40),
      recentRuns: this.ctx.store.recentRuns(10),
    };
  }
}
