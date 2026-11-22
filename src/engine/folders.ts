import type { Attempt, FolderRow, Meeting, MeetingTurn, Question, Run, Task } from "../store.js";
import type { EngineContext } from "./context.js";
import { KIND_LABEL, summarizeTurn, type Meetings } from "./meetings.js";
import type { Room } from "./room.js";
import type { Scheduler } from "./scheduler.js";

const LIVE_RANK = { awaiting_approval: 0, in_progress: 1, ready: 2 } as const;
const MEETING_PHASE = { proposal: 0, critique: 1, final: 2 } as const;
const HANDOFFS_PER_PAGE = 20;

export function isOpenRun(run?: Run | null) {
  return run?.status === "active" || run?.status === "awaiting_approval";
}

function folderOfRun(run: Run) {
  return run.meeting_id ? "m" + run.meeting_id : "r" + run.id;
}

type NowPlaying = {
  folder: string;
  task: string;
  stage: string;
  agent: string;
  attempt_id: number | null;
  stage_index: number;
  stage_count: number;
  since: string;
};

type Timeline = ReturnType<Room["timeline"]>;
type Inbox = ReturnType<Room["inbox"]>;

export type FolderCursor = { at: string; id: string };
function cursorOf(row: FolderRow) {
  return row.updated_at + "/" + row.id;
}
export function parseFolderCursor(value: string): FolderCursor | null {
  const [at, id, extra] = value.split("/");
  return id && extra === undefined && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)
    && Number.isFinite(Date.parse(at)) && /^[mr][1-9]\d*$/.test(id) ? { at, id } : null;
}

export function taskStates(tasks: Task[], attempts: Attempt[], scheduler: Scheduler) {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  return tasks.map((task) => {
    const history = attempts.filter((a) => a.task_id === task.id);
    const live = history.filter((a) => a.status in LIVE_RANK).at(-1);
    const deps = task.status === "pending" ? scheduler.unmetDependencies(task, byKey, attempts) : [];
    return {
      ...task, live: live ?? null, rounds: history.length,
      waiting: task.status === "pending" ? (deps.length ? "等 " + deps.join("、") : scheduler.taskWait(task.id) ?? null) : null,
    };
  });
}

export class Folders {
  constructor(
    private readonly ctx: EngineContext,
    private readonly meetings: Meetings,
    private readonly room: Room,
    private readonly scheduler: Scheduler,
  ) {}

  nowPlaying(run: Run | null, tasks: Task[], lives: Attempt[], meeting: (Meeting & { turns: MeetingTurn[] }) | null): NowPlaying[] {
    const items: NowPlaying[] = [];
    if (run && isOpenRun(run)) {
      const rank = (a: Attempt) => LIVE_RANK[a.status as keyof typeof LIVE_RANK];
      const ordered = [...lives].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
      for (const a of ordered) {
        const task = tasks.find((t) => t.id === a.task_id);
        const stages = task?.stages ?? this.ctx.cfg.pipeline;
        const index = stages.findIndex((s) => s.id === a.stage_id);
        items.push({
          folder: folderOfRun(run), task: task?.key ?? "T1", stage: stages[index]?.role ?? a.stage_id,
          agent: a.agent, attempt_id: a.id, stage_index: Math.max(0, index), stage_count: stages.length,
          since: a.started_at ?? a.assigned_at,
        });
      }
    }
    if (meeting?.status === "collecting") {
      const mail = this.ctx.store.mailWithPrefix("meeting-" + meeting.id + "-" + meeting.round + "-");
      for (const agent of this.meetings.expectedSpeakers(meeting)) {
        if (meeting.turns.some((turn) => turn.round === meeting.round && turn.agent === agent)) continue;
        items.push({
          folder: "m" + meeting.id, task: "第 " + meeting.round + " 轮", stage: KIND_LABEL[meeting.round_kind],
          agent, attempt_id: null, stage_index: MEETING_PHASE[meeting.round_kind], stage_count: 5,
          since: mail.find((m) => m.to_agent === agent)?.created_at ?? meeting.created_at,
        });
      }
    }
    return items;
  }

  needs(inbox: Inbox, timeline: Timeline, questions: Question[], nowPlaying: NowPlaying[]) {
    const counts = new Map<string, number>();
    const handoffs = new Map(timeline.filter((item) => item.type === "handoff").map((item) => [item.id, item.run_id]));
    const folderByRun = new Map<number, string>();
    const fromRun = (runId?: number | null) => {
      if (!runId) return [];
      if (!folderByRun.has(runId)) {
        const run = this.ctx.store.run(runId);
        if (run) folderByRun.set(runId, folderOfRun(run));
      }
      const id = folderByRun.get(runId);
      return id ? [id] : [];
    };
    for (const { ref, agent } of inbox) {
      let folders: string[];
      if (ref.type === "round") folders = ["m" + ref.meeting_id];
      else if (ref.type === "handoff") folders = fromRun(handoffs.get(ref.id));
      else if (ref.type === "question") folders = fromRun(questions.find((q) => q.id === ref.id)?.run_id);
      else folders = nowPlaying.filter((item) => item.agent === agent).map((item) => item.folder);
      for (const id of new Set(folders)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  page(limit: number, needs: Map<string, number>, before?: FolderCursor) {
    const rows = this.ctx.store.folderRows(limit + 1, before);
    const folders = rows.slice(0, limit).map((row) => this.summary(row, needs.get(row.id) ?? 0));
    return { folders, next_before: rows.length > limit ? cursorOf(rows[limit - 1]) : null };
  }

  detail(id: string, needs: number, requestedRound?: number, handoffsBefore?: number) {
    const store = this.ctx.store;
    const row = store.folderRow(id);
    if (!row) return null;
    const meeting = row.kind === "meeting" ? store.meeting(row.number)! : null;
    const run = row.run_id ? store.run(row.run_id)! : null;
    const attempts = run ? store.attempts(run.id) : [];
    const tasks = run ? taskStates(store.tasks(run.id), attempts, this.scheduler) : [];
    const gates = run && handoffsBefore === undefined ? store.gateHandoffs(run.id) : [];
    const limit = Math.max(0, HANDOFFS_PER_PAGE - gates.length);
    const before = handoffsBefore ?? Number.MAX_SAFE_INTEGER;
    const { items, count } = run ? store.handoffHistory(run.id, limit, before) : { items: [], count: 0 };
    const remaining = count - items.length;
    return {
      folder: this.summary(row, needs, meeting ?? undefined, tasks),
      meeting, run, tasks, attempts,
      rounds: meeting ? this.rounds(meeting, requestedRound) : [],
      handoffs: [...gates, ...items].map((h) => this.room.handoff(h)),
      handoffs_remaining: remaining,
      handoffs_before: remaining > 0 ? items.at(-1)?.id ?? before : null,
      events: store.folderEvents(run?.id ?? null, meeting?.id ?? null),
    };
  }

  private summary(row: FolderRow, needs: number, meeting?: Meeting, tasks?: Task[]) {
    const { id, kind, title, status, updated_at, tasks: total, done, handoffs, rounds } = row;
    const participants = kind === "meeting" ? (meeting ?? this.ctx.store.meeting(row.number))?.participants ?? [] : [];
    const runTasks = tasks ?? (row.run_id ? this.ctx.store.tasks(row.run_id) : []);
    const members = [...new Set([...participants, ...runTasks.flatMap((t) => t.stages.map((s) => s.agent))])];
    const group = needs > 0 ? "need" : ["done", "stopped", "cancelled"].includes(status) ? "done" : "run";
    return { id, kind, title, status, group, updated_at, members, counts: { tasks: total, done, handoffs, rounds }, needs_you: needs };
  }

  private rounds(meeting: Meeting, requestedRound?: number) {
    const byRound = new Map<number, MeetingTurn[]>();
    for (const turn of this.ctx.store.meetingTurns(meeting.id)) {
      const turns = byRound.get(turn.round) ?? [];
      turns.push(turn);
      byRound.set(turn.round, turns);
    }
    if (!byRound.has(meeting.round)) byRound.set(meeting.round, []);
    return [...byRound.entries()].reverse().map(([round, turns]) => {
      const current = meeting.round === round;
      const full = current || round === requestedRound;
      const kind = turns[0]?.kind ?? meeting.round_kind;
      const open = meeting.status !== "done" && meeting.status !== "cancelled";
      return {
        meeting_id: meeting.id, round, kind, current, full,
        status: current && open ? meeting.status : null,
        expected: current && open ? this.meetings.expectedSpeakers(meeting) : [],
        note: current ? meeting.round_note : null,
        turns: turns.map((turn) => full
          ? { agent: turn.agent, at: turn.created_at, content: turn.content, tasks: turn.tasks, decisions: turn.decisions, preview: turn.preview }
          : { agent: turn.agent, at: turn.created_at, summary: summarizeTurn(turn.content) }),
      };
    });
  }
}
