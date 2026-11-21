// The room timeline for the panel: chat, meeting rounds, handoffs (with their approval gates), open
// questions and system events, merged in time order. A read model only; actions go through the
// existing services (scheduler.decide, meetings.*, chat.post, workspace.answer).
import type { BridgeEvent, Handoff, Meeting, MeetingTurn, Question } from "../store.js";
import type { Chat } from "./chat.js";
import type { EngineContext } from "./context.js";
import type { DriftNotice } from "./diagnostics.js";
import { issueSummary } from "./issues.js";
import type { Meetings } from "./meetings.js";
import type { Postman } from "./postman.js";
import type { Scheduler } from "./scheduler.js";

export type TimelineCategory = "chat" | "meeting" | "task" | "other";
export type PanelTarget = { view: "meeting" | "chat" | "office"; anchor: string };

export interface DeliveryNotice {
  reason: "stuck" | "unanswered" | "never-joined" | "offline";
  agent: string;
  at: string;
  title: string;
  message: string;
}

type InboxRef = { type: "handoff" | "question"; id: number }
  | { type: "round"; meeting_id: number; round: number }
  | { type: "delivery" | "diagnostic"; id: string };

interface InboxItem {
  kind: "handoff_gate" | "meeting_final" | "meeting_stalled" | "question" | "delivery" | "diagnostic";
  id: string;
  title: string;
  agent: string | null;
  at: string;
  urgency: "high" | "normal";
  target: PanelTarget;
  ref: InboxRef;
}

const RUNS = 3; // handoffs of this many recent runs
const MEETINGS = 3;
const CHAT = 120;
const EVENTS = 250;
const MAX_ITEMS = 300;

// Events already shown as their own card, or too chatty for the room.
const HIDDEN_EVENT_KINDS = new Set(["doorbell", "handoff", "drift"]);
const CATEGORY: Record<string, TimelineCategory> = {
  meeting: "meeting",
  run: "task",
  task: "task",
  gate: "task",
  lease: "task",
  scope: "task",
  turn: "task",
  progress: "task",
};

export class Room {
  constructor(
    private readonly ctx: EngineContext,
    private readonly postman: Postman,
    private readonly scheduler: Scheduler,
    private readonly meetings: Meetings,
    private readonly chat: Chat,
  ) {}

  timeline(questions: Question[], deliveries: DeliveryNotice[], diagnoses: DriftNotice[], currentRun?: number, currentMeeting?: number) {
    const store = this.ctx.store;
    const items = [
      ...this.chat.recent(CHAT, (a) => this.postman.isBusy(a)).map((c) => ({ type: "chat" as const, cat: "chat" as const, at: c.created_at, ...c })),
      ...store.recentMeetings(MEETINGS).flatMap((m) => this.rounds(m)),
      ...store.recentRuns(RUNS).flatMap((run) => store.handoffs(run.id).map((h) => this.handoff(h))),
      ...questions.map((q) => ({ type: "question" as const, cat: "task" as const, at: q.created_at, id: q.id, agent: q.agent, question: q.question })),
      ...store.recentEvents(EVENTS).filter((e) => this.showEvent(e)).map((e) => ({
        type: "sys" as const, cat: CATEGORY[e.kind] ?? "other", at: e.created_at, id: e.id, kind: e.kind, agent: e.agent, text: e.text,
      })),
      ...deliveries.map((d) => ({ ...d, type: "delivery" as const, cat: "other" as const, id: `delivery-${d.agent}`, text: d.message })),
      ...diagnoses.map((d) => ({ ...d, type: "diagnostic" as const, cat: "other" as const, text: d.message })),
    ];

    // Stable order: by time, then by type so a handoff precedes the events it caused.
    const rank: Record<string, number> = { round: 0, handoff: 1, chat: 2, question: 3, sys: 4, delivery: 5, diagnostic: 6 };
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank[a.type] - rank[b.type]));
    // A long chat must not evict an actionable card or part of the current meeting/task history.
    const required = (it: (typeof items)[number]) => it.type === "question" || it.type === "delivery" || it.type === "diagnostic"
      || (it.type === "round" && (it.status !== null || it.meeting_id === currentMeeting))
      || (it.type === "handoff" && (it.gate !== null || it.run_id === currentRun));
    let history = Math.max(0, MAX_ITEMS - items.filter(required).length);
    const visible = [];
    for (const it of items.reverse()) {
      if (required(it)) visible.push(it);
      else if (history > 0) {
        visible.push(it);
        history--;
      }
    }
    return visible.reverse();
  }

  inbox(timeline: ReturnType<Room["timeline"]>) {
    const items: InboxItem[] = [];
    for (const it of timeline) {
      if (it.type === "handoff" && it.gate) {
        items.push({
          kind: "handoff_gate", id: `gate-${it.gate.attempt_id}`,
          title: `${it.task ? it.task.key + " " : ""}${it.stage_role}交接待审批`,
          agent: it.agent, at: it.at, urgency: "high",
          target: { view: "meeting", anchor: `handoff-${it.id}` }, ref: { type: "handoff", id: it.id },
        });
      } else if (it.type === "round" && (it.status === "awaiting_approval" || it.status === "review")) {
        const final = it.status === "awaiting_approval";
        items.push({
          kind: final ? "meeting_final" : "meeting_stalled",
          id: `meeting-${it.meeting_id}-${it.round}`,
          title: final ? `批准会议「${it.topic}」的定稿` : `决定会议「${it.topic}」的下一步`,
          agent: final ? it.facilitator : null, at: it.turns.at(-1)?.at ?? it.at,
          urgency: final ? "high" : "normal", target: { view: "meeting", anchor: `round-${it.meeting_id}-${it.round}` },
          ref: { type: "round", meeting_id: it.meeting_id, round: it.round },
        });
      } else if (it.type === "question") {
        items.push({
          kind: "question", id: `question-${it.id}`, title: `${it.agent} 有问题等你回答`, agent: it.agent, at: it.at, urgency: "normal",
          target: { view: "chat", anchor: `question-${it.id}` }, ref: { type: "question", id: it.id },
        });
      } else if (it.type === "delivery") {
        items.push({
          kind: "delivery", id: it.id, title: it.title, agent: it.agent, at: it.at, urgency: "high",
          target: { view: "office", anchor: `member-${it.agent}` }, ref: { type: "delivery", id: it.id },
        });
      } else if (it.type === "diagnostic") {
        items.push({
          kind: "diagnostic", id: it.id, title: it.title, agent: it.agent, at: it.at, urgency: "normal",
          target: { view: "office", anchor: it.agent ? "member-" + it.agent : it.id }, ref: { type: "diagnostic", id: it.id },
        });
      }
    }
    return items.sort((a, b) => Number(b.urgency === "high") - Number(a.urgency === "high") || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  private showEvent(e: BridgeEvent) {
    if (HIDDEN_EVENT_KINDS.has(e.kind)) return false;
    if (e.kind === "meeting" && /轮.{0,4}发言$/.test(e.text)) return false; // a turn: the round card shows it
    if (e.kind === "gate" && e.text.endsWith("等待你在面板上审批")) return false; // the handoff card carries the gate
    return true;
  }

  /** One card per meeting round that has turns. The latest round of an open meeting carries its controls. */
  private rounds(m: Meeting) {
    const turns = this.ctx.store.meetingTurns(m.id);
    const byRound = new Map<number, MeetingTurn[]>();
    for (const t of turns) byRound.set(t.round, [...(byRound.get(t.round) ?? []), t]);
    const open = ["collecting", "review", "awaiting_approval"].includes(m.status);
    return [...byRound.entries()].map(([round, ts]) => {
      const current = open && round === m.round;
      return {
        type: "round" as const,
        cat: "meeting" as const,
        at: ts[0].created_at,
        meeting_id: m.id,
        topic: m.topic,
        facilitator: m.facilitator,
        round,
        kind: ts[0].kind,
        turns: ts.map((t) => ({ agent: t.agent, at: t.created_at, content: t.content, decisions: t.decisions, tasks: t.tasks })),
        // Controls on the current round: what the human can do now.
        status: current ? m.status : null,
        expected: current ? this.meetings.expectedSpeakers(m) : null,
        note: current ? m.round_note : null,
        doc_path: m.status === "done" && round === m.round ? m.doc_path : null,
      };
    });
  }

  handoff(h: Handoff) {
    const a = this.ctx.store.attempt(h.attempt_id);
    const task = a?.task_id ? this.ctx.store.task(a.task_id) : undefined;
    const multi = task ? this.ctx.store.tasks(task.run_id).length > 1 : false;
    const stage = task?.stages.find((s) => s.id === h.stage_id) ?? this.ctx.cfg.pipeline.find((s) => s.id === h.stage_id);
    let gate = null;
    if (a?.status === "awaiting_approval") {
      gate = {
        attempt_id: a.id,
        reject_to: stage?.on_reject ?? a.stage_id,
        reject_first: h.data.verdict === "reject",
        feedback: this.scheduler.parseFeedback(a.feedback),
      };
    }
    return {
      type: "handoff" as const,
      cat: "task" as const,
      at: h.created_at,
      id: h.id,
      run_id: h.run_id,
      task_id: a?.task_id ?? null,
      agent: h.agent,
      stage_id: h.stage_id,
      stage_role: stage?.role ?? h.stage_id,
      task: task && multi ? { key: task.key, title: task.title } : null,
      data: h.data,
      issue_summary: issueSummary(h.data),
      commit_sha: h.commit_sha,
      commit_error: h.commit_error,
      scope_notes: h.scope_notes,
      gate,
    };
  }
}
