// Session bindings and each agent's in-memory presence.
import type { Doorbells, DoorbellKind } from "../doorbells/index.js";
import type { BridgeClient } from "../products/types.js";
import { err, type EngineContext, type Result } from "./context.js";

// Length of one busy_minutes minute. Only the smoke test shortens it.
const BUSY_MINUTE_MS = Number(process.env.BRIDGE_BUSY_MINUTE_MS) || 60_000;

export type PresenceStatus = "working" | "armed" | "waiting" | "idle" | "stale" | "offline" | "never-joined";

interface AgentPresence {
  id: string;
  client?: BridgeClient & { reportedAt: string };
  sessionId?: string; // the one MCP session allowed to act as this agent
  canRecover?: boolean; // set only when the bound MCP session closes
  boundAt?: number;
  joinedAt?: number; // last successful join, even from the same MCP session (a new Codex thread may share one)
  lastSeenAt?: number; // last tool call from the bound session
  // Counts the same activity as lastSeenAt. A doorbell check compares counts, not timestamps: the call that
  // caused a ring and a new call after it can share a millisecond.
  callSeq: number;
  doorbellError?: string;
  // report_progress(busy_minutes): a long command is running for this attempt in this binding (in memory only).
  busy?: { attemptId: number; sessionId: string; until: number; timer: ReturnType<typeof setTimeout> };
  lastRingAt?: number;
  lastRingKind?: DoorbellKind;
  // wait_for_mail (poll fallback) metrics, kept from M0
  waiting: boolean;
  waitCalls: number;
  lastPollAt?: number;
  lastReturnAt?: number;
  maxGapMs: number;
  totalGapMs: number;
  gapCount: number;
}

export class Presence {
  private readonly agents = new Map<string, AgentPresence>();
  // Doorbell a client announced for its MCP session (the Claude proxy sends x-bridge-doorbell on every request),
  // so an identity recovered on any tool call gets its doorbell back, not only one recovered through join.
  private readonly sessionDoorbell = new Map<string, string>();
  private readonly sessionAcpAgent = new Map<string, string>();
  /** Set by the HTTP layer: is this MCP session still open? */
  isSessionOpen: (sessionId: string) => boolean = () => true;

  constructor(
    private readonly ctx: EngineContext,
    private readonly doorbells: Doorbells,
    private readonly callbacks: {
      wakeWaiter(agent: string): void;
      resendLiveTask(agent: string): void;
    },
  ) {
    for (const id of Object.keys(ctx.cfg.agents))
      this.agents.set(id, { id, callSeq: 0, waiting: false, waitCalls: 0, maxGapMs: 0, totalGapMs: 0, gapCount: 0 });
  }

  get(agent: string) {
    return this.agents.get(agent);
  }

  /** Record a tool call (or a wait_for_mail return) from the agent's bound session. */
  touch(agent: string) {
    const p = this.agents.get(agent);
    if (!p) return;
    p.lastSeenAt = Date.now();
    p.callSeq++;
  }

  /** report_progress(busy_minutes): no ack_overdue for this attempt's task mail until `until`. Replaces any earlier period. */
  setBusy(agent: string, attemptId: number, minutes: number) {
    const p = this.agents.get(agent)!;
    this.clearBusy(agent);
    const until = Date.now() + minutes * BUSY_MINUTE_MS;
    // Lets the panel drop the "long command" line when the period ends, without waiting for another change.
    const timer = setTimeout(() => this.busy(agent) ?? this.ctx.onChange(), until - Date.now() + 50);
    timer.unref?.();
    p.busy = { attemptId, sessionId: p.sessionId!, until, timer };
    return until;
  }

  clearBusy(agent: string) {
    const p = this.agents.get(agent);
    if (!p?.busy) return;
    clearTimeout(p.busy.timer);
    p.busy = undefined;
  }

  /** The live busy period, if any: same binding, not expired, and its attempt still in progress. Otherwise it is cleared. */
  busy(agent: string): { attemptId: number; until: number } | undefined {
    const p = this.agents.get(agent);
    const b = p?.busy;
    if (!b) return undefined;
    if (b.sessionId === p.sessionId && Date.now() < b.until && this.ctx.store.attempt(b.attemptId)?.status === "in_progress")
      return { attemptId: b.attemptId, until: b.until };
    this.clearBusy(agent);
    return undefined;
  }

  markReturned(agent: string) {
    this.agents.get(agent)!.lastReturnAt = Date.now();
  }

  agentIds() {
    return [...this.agents.keys()];
  }
  isAgent(id: string) {
    return this.agents.has(id);
  }
  rolesOf(agent: string) {
    return this.ctx.cfg.pipeline.filter((s) => s.agent === agent).map((s) => `${s.id}（${s.role}）`);
  }

  /** The doorbell the agent should expect (decides what join and the tools tell it about waiting). */
  doorbellKind(agent: string, sessionId = this.get(agent)?.sessionId): DoorbellKind {
    if (this.acpAgent(sessionId) === agent) return "acp";
    const kind = this.doorbells.primary(agent).kind;
    return kind === "acp" && sessionId ? "poll" : kind;
  }

  recentlyPolling(agent: string) {
    const p = this.get(agent);
    return !!p?.sessionId && this.isSessionOpen(p.sessionId) && !this.acpAgent(p.sessionId)
      && (p.waiting || Date.now() - (p.lastPollAt ?? 0) < this.ctx.cfg.wait.stale_after_seconds * 1000);
  }

  acpAgent(sessionId: string | undefined) {
    return sessionId ? this.sessionAcpAgent.get(sessionId) : undefined;
  }

  doorbellArmed(agent: string) {
    return this.doorbells.armed(agent);
  }

  status(id: string): PresenceStatus {
    const p = this.agents.get(id)!;
    const run = this.ctx.store.openRun();
    if (run && this.ctx.store.agentAttempts(run.id, id, ["in_progress"]).length) return "working";
    if (this.ctx.store.mailByStatus(id, ["fetched"]).some((m) => m.kind === "meeting")) return "working";
    if (p.waiting) return "waiting";
    if (this.doorbellArmed(id)) return "armed";
    if (!p.lastSeenAt) return "never-joined";
    if (!p.sessionId && !this.doorbells.sessionless(id)) return "offline";
    const since = Date.now() - Math.max(p.lastSeenAt, p.lastReturnAt ?? 0);
    if (since > this.ctx.cfg.wait.offline_after_seconds * 1000) return "offline";
    if (since > this.ctx.cfg.wait.stale_after_seconds * 1000) return "stale";
    return "idle";
  }

  /** When the agent's current conversation may have started: its binding or its last join, whichever is later. */
  conversationSince(agent: string): number | undefined {
    const p = this.agents.get(agent);
    if (!p?.boundAt) return undefined;
    return Math.max(p.boundAt, p.joinedAt ?? 0);
  }

  bindingError(agent: string, sessionId: string | undefined): string | null {
    const p = this.agents.get(agent);
    if (!p) return `未知 agent_id，可选：${this.agentIds().join(", ")}`;
    if (!p.sessionId) return `你还没有以 ${agent} 身份 join，请先调用 join。`;
    if (p.sessionId !== sessionId) {
      if (this.acpAgent(p.sessionId) === agent) return `身份 ${agent} 已被接管，后台会话正在处理协作桥的信。`;
      return `身份 ${agent} 已被另一个会话占用。请确认你的身份（可选：${this.agentIds().join(", ")}）；如果确实是你，用 join(agent_id, takeover=true) 接管。`;
    }
    this.touch(agent);
    return null;
  }

  private bind(p: AgentPresence, sessionId: string | undefined) {
    if (p.sessionId !== sessionId) {
      this.clearBusy(p.id);
      p.boundAt = Date.now();
      p.client = undefined;
      p.lastPollAt = undefined;
    }
    p.sessionId = sessionId;
    p.canRecover = false;
    this.touch(p.id);
  }

  setSessionDoorbell(sessionId: string, hint: string | undefined, acpAgent?: string) {
    if (hint) this.sessionDoorbell.set(sessionId, hint);
    if (acpAgent) this.sessionAcpAgent.set(sessionId, acpAgent);
  }

  private applyDoorbellHint(p: AgentPresence, hint: string | undefined) {
    if (hint !== "claude-socket") return;
    this.doorbells.claudeSocket.markRegistered(p.id);
    p.doorbellError = undefined;
  }

  /** The next MCP tool call may claim an identity orphaned by a closed session. */
  recoverBinding(agent: string, sessionId: string | undefined): boolean {
    const p = this.agents.get(agent);
    if (!sessionId || !p?.canRecover || p.sessionId) return false;
    if (this.acpAgent(sessionId) && !this.doorbells.acp.connecting(agent)) return false;
    this.ctx.store.setResumeKey(agent);
    this.bind(p, sessionId);
    this.applyDoorbellHint(p, this.sessionDoorbell.get(sessionId));
    this.ctx.log("identity_recovered", { agent, session: sessionId });
    this.ctx.event(null, agent, "join", `${agent} 的 MCP 会话关闭后已重新绑定`);
    this.callbacks.resendLiveTask(agent);
    return true;
  }

  join(agent: string, sessionId: string | undefined, takeover = false, doorbellHint?: string, recovery?: { key: string; replay: boolean }, client?: BridgeClient): Result {
    const p = this.agents.get(agent);
    if (!p) return err(`未知 agent_id，可选：${this.agentIds().join(", ")}`);
    const acp = this.acpAgent(sessionId) === agent;
    if (acp) {
      if (!this.doorbells.acp.connecting(agent)) return err("后台会话已停止。");
      if (this.recentlyPolling(agent)) return err("交互会话正在等信，本回合请结束。");
      takeover = true;
    }
    if (recovery?.replay && (!takeover || this.ctx.store.resumeKey(agent) !== recovery.key))
      return { error: `${agent} 的旧连接已失效，请重新调用 join。`, recovery_revoked: true };
    const st = this.status(agent);
    const boundElsewhere = p.sessionId && p.sessionId !== sessionId && this.isSessionOpen(p.sessionId) && st !== "offline";
    if (boundElsewhere && !takeover) {
      this.ctx.log("join_rejected", { agent, session: sessionId, boundTo: p.sessionId });
      const idleS = p.lastSeenAt ? Math.round((Date.now() - p.lastSeenAt) / 1000) : null;
      const releaseIn = idleS === null ? null : Math.max(0, this.ctx.cfg.wait.offline_after_seconds - idleS);
      return {
        error: this.acpAgent(p.sessionId) === agent
          ? `身份 ${agent} 已被接管，后台会话正在处理协作桥的信。`
          : `身份 ${agent} 已被另一个会话占用。你很可能拿错了启动提示词，请确认自己的身份（可选：${this.agentIds().join(", ")}）。`,
        bound_session: p.sessionId,
        bound_since: p.boundAt ? new Date(p.boundAt).toISOString() : null,
        bound_session_idle_seconds: idleS,
        auto_release_in_seconds: releaseIn,
        options: [
          "如果旧会话已经不用了：用 takeover=true 重新 join，立即接管。",
          "或者请用户在面板「成员」表里点「释放」，再重新 join。",
          releaseIn !== null ? `或者等约 ${releaseIn} 秒，旧会话无活动后会被视为离线，届时可直接 join。` : "",
        ].filter(Boolean),
      };
    }
    if (!recovery?.replay) this.ctx.store.setResumeKey(agent, recovery?.key);
    if (p.sessionId && p.sessionId !== sessionId) {
      this.callbacks.wakeWaiter(agent);
      this.doorbells.claudeSocket.disarm(agent);
      this.ctx.log("join_takeover", { agent, from: p.sessionId, to: sessionId });
    }
    this.bind(p, sessionId);
    p.joinedAt = Date.now();
    this.applyDoorbellHint(p, doorbellHint ?? (sessionId ? this.sessionDoorbell.get(sessionId) : undefined));
    if (client) p.client = { ...client, reportedAt: new Date().toISOString() };
    const bell = this.doorbells.get(this.doorbellKind(agent, sessionId));
    const kind = bell.kind;
    this.ctx.log("join", { agent, session: sessionId, doorbell: kind, chain: this.doorbells.chain(agent), recovered: recovery?.replay || undefined });
    this.ctx.event(null, agent, "join", `${agent} ${recovery?.replay ? "重新连接" : "加入"}（门铃：${bell.label}）`);
    this.callbacks.resendLiveTask(agent);

    return {
      agent_id: agent,
      doorbell: kind,
      roles: this.rolesOf(agent),
      pipeline: this.ctx.cfg.pipeline.map((s) => `${s.id}：${s.role}（${s.agent}${s.gate ? "，完成后需人工批准" : ""}）`),
      task_template: this.ctx.cfg.task_template.map((s) => `${s.id}：${s.role}（${s.agent === "owner" ? "任务负责人" : s.agent === "reviewer" ? "任务审查人" : s.agent}${s.gate ? "，完成后需人工批准" : ""}）`),
      protocol: [
        "如果协作桥工具是延迟加载的，先用一次工具搜索（如 ToolSearch）同时加载 submit_handoff、submit_meeting_turn、fetch_inbox、ack、say 和 report_progress。",
        "1. 现在先调用一次 fetch_inbox(agent_id)，处理里面的信。",
        "2. task 信：按其中的 task、stage、input_handoff 和 feedback 完成本阶段工作；需要更多背景时调用 get_context；可用 report_progress 汇报进度（预计超过 5 分钟不调用桥工具时，比如跑完整 smoke，先 report_progress 并带上 busy_minutes）、post_note 记录共享约定、ask_human 向用户提问（答复会以信件送达）。完成后调用 submit_handoff（桥会自动 git 提交并确认这封信）。",
        "3. meeting 信：这是会议的一轮发言（提案 / 互评 / 定稿），按其中的 meeting.instructions 发言，然后调用 submit_meeting_turn（自动确认这封信）。",
        "4. 多个任务并行时，桥已为每个任务租下它的 paths。要改本任务 paths 以外的文件，先调用 reserve_paths；冲突时它会告诉你谁占着，不要硬改。",
        "5. chat 信：用户或其他成员在聊天里找你，不需要 ack；需要回答时调用 say（带 reply_to），回答要简短。其他 ack_required 的信：处理完调用 ack。需要正式找其他成员时用 send_mail。",
        ...bell.waitInstructions(agent),
        "「[协作桥]」消息只负责叫醒你，具体内容一律以 fetch_inbox 为准。",
      ],
    };
  }

  sessionClosed(sessionId: string) {
    this.sessionDoorbell.delete(sessionId);
    this.sessionAcpAgent.delete(sessionId);
    for (const p of this.agents.values())
      if (p.sessionId === sessionId) {
        p.sessionId = undefined;
        p.canRecover = true;
        this.clearBusy(p.id);
        this.callbacks.wakeWaiter(p.id);
        this.doorbells.claudeSocket.disarm(p.id);
        this.ctx.log("agent_unbound", { agent: p.id, session: sessionId });
        this.ctx.onChange();
      }
  }

  /** Free an identity: from the panel (human) or the agent itself via `leave`. */
  release(agent: string, by: "human" | "agent", sessionId?: string): Result {
    const p = this.agents.get(agent);
    if (!p) return err("未知 agent");
    if (by === "agent") {
      const be = this.bindingError(agent, sessionId);
      if (be) return err(be);
    }
    const old = p.sessionId;
    this.ctx.store.setResumeKey(agent);
    p.sessionId = undefined;
    p.canRecover = false;
    this.clearBusy(agent);
    this.callbacks.wakeWaiter(agent);
    this.doorbells.claudeSocket.disarm(agent);
    this.ctx.log("identity_released", { agent, by, session: old });
    this.ctx.event(null, agent, "join", `${agent} 的身份已释放（${by === "human" ? "你在面板上操作" : "它自己退出"}）`);
    return { ok: true, released_session: old ?? null };
  }
}
