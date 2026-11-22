// Deliver mail, ring doorbells and retry unread deliveries.
import { randomUUID } from "node:crypto";
import { CODEX_THREAD, type Doorbell, type Doorbells, type DoorbellKind, type RingOutcome, type RingResult } from "../doorbells/index.js";
import type { Mail, MailKind } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Presence } from "./presence.js";

// After a ring, how long to wait for a sign of life (any tool call) before trying the next doorbell in the
// agent's chain or telling the human. A woken agent may think a while before its first tool call.
const WAKE_GRACE_MS = Number(process.env.BRIDGE_WAKE_GRACE_SECONDS ?? process.env.BRIDGE_CODEX_WAKE_GRACE_SECONDS ?? 30) * 1000;
const RECENT_TURN_MS = 60_000;
const turnExtraSeconds = Number(process.env.BRIDGE_WAKE_TURN_EXTRA_SECONDS ?? 90);
const TURN_EXTRA_MS = Number.isFinite(turnExtraSeconds) ? Math.max(0, turnExtraSeconds) * 1000 : 90_000;
export const LIVE_MAIL = ["queued", "rung", "stuck"] as const;
// Queued mail that no doorbell can deliver (e.g. Claude closed the conversation): tell the human this soon,
// without marking it stuck, so it is still delivered when the agent comes back.
const UNREACHABLE_ALERT_MS = Number(process.env.BRIDGE_UNREACHABLE_ALERT_SECONDS ?? 15) * 1000;

export class Postman {
  private readonly wakeAlerts = new Set<string>(); // mail IDs already reported to the human as "rang, no response"
  private readonly mailWakers = new Map<string, () => void>();
  // In-process parked-hook delivery and its scheduled verification share the same mail ID array.
  private readonly verifications = new WeakMap<string[], { counted: boolean; disconnected: boolean }>();
  private readonly deferredWakes = new Map<string, string[]>();
  shuttingDown = false;

  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly doorbells: Doorbells,
    private readonly payloads: {
      task(mail: Mail): Result | null;
      meeting(mail: Mail): Result | null;
      chat(mail: Mail): Result | null;
    },
  ) {}

  startSweep(retryBlockedTasks: () => void) {
    setInterval(() => {
      this.sweep();
      retryBlockedTasks();
    }, 5_000).unref();
  }

  isUnanswered(id: string) {
    return this.wakeAlerts.has(id);
  }

  /** A live MCP session is still working on a fetched task or meeting turn. */
  isBusy(agent: string) {
    const session = this.presence.get(agent)?.sessionId;
    return !!session && this.presence.isSessionOpen(session) && this.presence.status(agent) === "working";
  }

  wakeWaiter(agent: string) {
    this.mailWakers.get(agent)?.();
  }

  private get pollMs() {
    return this.ctx.cfg.wait.poll_seconds * 1000;
  }

  /** Doorbell long-poll from the stdio proxy (claude-socket) or a parking Codex Stop hook (codex-hook). */
  doorbellWait(agent: string, kind: "claude-socket" | "codex-hook", timeoutMs: number, signal: AbortSignal): Promise<RingResult> {
    const driver = kind === "claude-socket" ? this.doorbells.claudeSocket : this.doorbells.codexHook;
    const r = driver.wait(agent, timeoutMs, signal, () => this.ctx.onChange());
    if (this.ctx.store.mailByStatus(agent, ["queued"]).length) this.kick(agent);
    return r;
  }

  /**
   * A client tells the bridge where it can be reached outside MCP — today the Codex Stop hook, at the end
   * of every turn of a conversation that joined, registering its conversation id. `park` tells the hook
   * whether to stay parked as the doorbell (false when a codex-queue doorbell can now reach the agent).
   */
  registerEndpoint(agent: string, kind: string, address: string): Result {
    if (!this.presence.isAgent(agent)) return err("未知 agent");
    if (!address) return err("address 不能为空");
    const prev = this.ctx.store.endpoint(agent, kind);
    this.ctx.store.setEndpoint(agent, kind, address);
    if (prev?.address !== address) this.ctx.log("endpoint_registered", { agent, kind, address });
    let park = true;
    if (kind === CODEX_THREAD) {
      const chain = this.doorbells.chain(agent);
      const q = chain.indexOf("codex-queue");
      const h = chain.indexOf("codex-hook");
      park = !(q >= 0 && (h < 0 || q < h) && this.doorbells.available(agent, "codex-queue"));
    }
    this.ctx.onChange();
    if (!park) this.kick(agent); // mail that arrived while the agent was mid-turn
    return { ok: true, park };
  }

  /** The proxy reports whether writing to the Claude messaging socket worked. */
  doorbellResult(agent: string, mailIds: string[], ok: boolean, error?: string, kind: "claude-socket" | "codex-hook" | "acp" = "claude-socket") {
    const p = this.presence.get(agent)!;
    const bell = this.doorbells.get(kind);
    if (ok) {
      p.doorbellError = undefined;
      if (!bell.verify) this.doorbells.recordResult(agent, bell, "delivered");
      return;
    }
    const verification = this.verifications.get(mailIds);
    if (verification) {
      if (verification.disconnected) return;
      verification.disconnected = true;
      if (!verification.counted) this.doorbells.recordRing(agent, bell);
    }
    this.releaseDeferredWake(mailIds);
    this.ringFailed(agent, bell, mailIds, error ?? "未知原因", new Set([kind]));
  }

  sendMail(m: { id?: string; run_id?: number | null; attempt_id?: number | null; from: string; to: string; kind: MailKind; subject: string; body: string; importance?: "normal" | "high"; ack_required?: boolean }) {
    const id = m.id ?? `${m.kind}-${randomUUID()}`;
    const created = this.ctx.store.addMail({
      id,
      run_id: m.run_id ?? null,
      attempt_id: m.attempt_id ?? null,
      from_agent: m.from,
      to_agent: m.to,
      kind: m.kind,
      subject: m.subject,
      body: m.body,
      importance: m.importance ?? "normal",
      ack_required: m.ack_required ? 1 : 0,
    });
    if (!created) {
      this.ctx.log("mail_duplicate", { id });
      return { id, duplicate: true };
    }
    this.ctx.log("mail_queued", { id, to: m.to, kind: m.kind, subject: m.subject });
    this.kick(m.to);
    this.ctx.onChange();
    return { id, duplicate: false };
  }

  /**
   * Something is waiting for `agent`: wake its blocked wait_for_mail, and ring the first doorbell in its
   * chain that can deliver now (skipping `tried`). A failed ring falls through to the next doorbell; a
   * successful one is checked for a sign of life after its grace period.
   */
  kick(agent: string, tried: ReadonlySet<DoorbellKind> = new Set()) {
    if (this.shuttingDown) return;
    const queued = this.ctx.store.mailByStatus(agent, ["queued"]);
    if (!queued.length) return;
    const mw = this.mailWakers.get(agent);
    if (mw) {
      this.mailWakers.delete(agent);
      mw();
    }
    const bell = this.doorbells.pick(agent, tried);
    // Leave new mail queued while the ACP turn is cancelling, so it does not spend its ring attempts.
    if (!bell || (bell.kind === "acp" && this.doorbells.acp.cancelling(agent))) return;
    const ids = queued.map((m) => m.id);
    const text =
      `[协作桥] ${agent}，你有 ${queued.length} 封新信：` +
      queued.map((m) => m.subject).slice(0, 5).join("；") +
      (queued.length > 5 ? " 等" : "") +
      `。请调用 bridge 的 fetch_inbox（agent_id="${agent}"）查看并处理。`;
    this.ctx.store.setMailStatus(ids, "rung");
    const p = this.presence.get(agent)!;
    const rangAt = Date.now();
    const seqAtRing = p.callSeq;
    const deferred = bell.verify && bell.waitsForTurn && TURN_EXTRA_MS > 0 && rangAt - (p.lastSeenAt ?? 0) <= RECENT_TURN_MS;
    const graceMs = WAKE_GRACE_MS + (deferred ? TURN_EXTRA_MS : 0);
    if (deferred) for (const id of ids) this.deferredWakes.set(id, ids);
    p.lastRingAt = rangAt;
    p.lastRingKind = bell.kind;
    this.ctx.log("doorbell_ring", { agent, via: bell.kind, mails: ids });
    this.ctx.event(null, agent, "doorbell", `按门铃叫醒 ${agent}（${bell.label}，${queued.length} 封信）`);
    const nowTried = new Set([...tried, bell.kind]);
    const verification = bell.verify ? { counted: false, disconnected: false } : undefined;
    if (verification) this.verifications.set(ids, verification);
    bell
      .ring({ agent, mailIds: ids, text })
      .catch((e): RingOutcome => ({ ok: false, error: String(e?.message ?? e) }))
      .then((o) => {
        if (verification?.disconnected) return;
        const measured = !o.ok || !o.reused;
        if (measured) {
          if (verification) verification.counted = true;
          this.doorbells.recordRing(agent, bell);
        }
        if (o.ok) {
          if (o.note) this.ctx.log("doorbell_note", { agent, via: bell.kind, note: o.note });
          if (verification) setTimeout(() => {
            this.releaseDeferredWake(ids);
            if (!verification.disconnected) this.checkWake(agent, bell, ids, seqAtRing, graceMs, nowTried, measured);
          }, graceMs).unref();
          return;
        }
        this.releaseDeferredWake(ids);
        this.ringFailed(agent, bell, ids, o.error, nowTried, o.cooldown);
      });
  }

  retryAcpMail(agent: string, ids?: string[]) {
    const statuses = ids ? ["rung"] as const : ["rung", "stuck"] as const;
    const unread = this.ctx.store.mailByStatus(agent, [...statuses]).filter((mail) => !ids || ids.includes(mail.id));
    this.ctx.store.setMailStatus(unread.map((mail) => mail.id), "queued");
    this.kick(agent);
  }

  voidMails(ids: string[], acknowledged: string[] = []) {
    this.ctx.store.setMailStatus(ids, "void");
    return this.cancelAcpMail([...ids, ...acknowledged]);
  }

  cancelAcpMail(ids: string[]) {
    return ids.length ? this.doorbells.acp.voided(ids) : undefined;
  }

  isCancellingAcp(agent: string, sessionId: string | undefined) {
    return this.presence.acpAgent(sessionId) === agent && this.doorbells.acp.cancelling(agent);
  }

  private releaseDeferredWake(ids: string[]) {
    for (const id of ids) if (this.deferredWakes.get(id) === ids) this.deferredWakes.delete(id);
  }

  /** A ring didn't go through: put the mail back and try the next doorbell in the chain. */
  private ringFailed(agent: string, bell: Doorbell, ids: string[], error: string, tried: ReadonlySet<DoorbellKind>, cooldown = false) {
    const p = this.presence.get(agent)!;
    this.doorbells.recordResult(agent, bell, "failed", cooldown);
    p.doorbellError = `${bell.label}：${error}`;
    this.ctx.log("doorbell_failed", { agent, via: bell.kind, error });
    this.ctx.event(null, agent, "doorbell", `${agent} 的门铃（${bell.label}）失败：${error}，信件会重新投递`);
    const back = ids.filter((id) => this.ctx.store.mail(id)?.status === "rung");
    this.ctx.store.setMailStatus(back, "queued");
    const next = this.doorbells.pick(agent, tried);
    this.kick(agent, tried); // also wakes a blocked wait_for_mail
    if (!next && !this.presence.get(agent)!.waiting) this.alertUnanswered(agent, bell, back);
    this.ctx.onChange();
  }

  /** No doorbell got through: tell the human once per mail. */
  private alertUnanswered(agent: string, bell: Doorbell, ids: string[]) {
    const fresh = ids.filter((id) => !this.wakeAlerts.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.wakeAlerts.add(id);
    this.ctx.event(null, agent, "doorbell", `${agent} 已响铃（${bell.label}），仍有 ${fresh.length} 封信未取`);
    this.ctx.notifyHuman(`协作桥：需要你叫醒 ${agent}`, `${agent} 已响铃但尚未取信。请在该对话里说「继续」。`);
  }

  /**
   * After a ring: any tool call from the agent means it woke up and will fetch in its own time, and an agent
   * already busy on a bridge task reads its mail when it gets to it. Otherwise try the next doorbell, and
   * when none is left, ask the human.
   */
  private checkWake(agent: string, bell: Doorbell, ids: string[], seqAtRing: number, graceMs: number, tried: ReadonlySet<DoorbellKind>, measured: boolean) {
    const statuses = ids.map((id) => this.ctx.store.mail(id)?.status);
    if ((this.presence.get(agent)?.callSeq ?? 0) > seqAtRing || this.isBusy(agent) || statuses.some((s) => s === "fetched" || s === "acked")) {
      if (measured) this.doorbells.recordResult(agent, bell, "confirmed");
      return;
    }
    if (bell.kind === "acp" && this.doorbells.acp.cancelling(agent)) return;
    const unread = ids.filter((_, index) => statuses[index] === "rung" || statuses[index] === "queued");
    if (!unread.length) return;
    if (measured) this.doorbells.recordResult(agent, bell, "timeout");
    const unreported = unread.filter((id) => !this.wakeAlerts.has(id));
    if (!unreported.length) return;
    this.ctx.log("wake_timeout", { agent, via: bell.kind, mails: unreported, graceMs });
    const next = this.doorbells.pick(agent, tried);
    if (next) {
      this.ctx.event(null, agent, "doorbell", `${agent} 对「${bell.label}」没有反应，改用「${next.label}」`);
      this.ctx.store.setMailStatus(unreported.filter((id) => this.ctx.store.mail(id)?.status === "rung"), "queued");
      this.kick(agent, tried);
      return;
    }
    this.alertUnanswered(agent, bell, unreported);
    this.ctx.onChange();
  }

  /** Periodic: re-ring mail nobody fetched, give up after max_rings, flag overdue acks, retry lease-blocked tasks. */
  private sweep() {
    if (this.shuttingDown) return;
    const now = Date.now();
    const { ring_retry_seconds, max_rings, ack_timeout_seconds } = this.ctx.cfg.mail;
    for (const id of this.wakeAlerts) {
      const status = this.ctx.store.mail(id)?.status;
      if (!status || !LIVE_MAIL.some((s) => s === status)) this.wakeAlerts.delete(id);
    }
    for (const m of this.ctx.store.allMailByStatus(["rung"])) {
      if (this.doorbells.acp.cancelling(m.to_agent)) continue;
      const lastReturn = this.presence.get(m.to_agent)?.lastReturnAt ?? 0;
      if (now - Math.max(Date.parse(m.rung_at!), lastReturn) < ring_retry_seconds * 1000) continue;
      // A delivered wake can be waiting in the client's queue while its current turn finishes.
      if (this.deferredWakes.has(m.id) || this.isBusy(m.to_agent)) continue;
      if (m.ring_count >= max_rings) {
        this.ctx.store.setMailStatus([m.id], "stuck");
        this.ctx.log("mail_stuck", { id: m.id, to: m.to_agent });
        this.ctx.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 没有响应门铃：「${m.subject}」`);
        if (!this.wakeAlerts.has(m.id))
          this.ctx.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `门铃按了 ${m.ring_count} 次没有回应。请在 ${m.to_agent} 里说「继续」。`);
      } else {
        this.ctx.store.setMailStatus([m.id], "queued");
        this.kick(m.to_agent);
      }
    }
    // No doorbell can reach the agent right now (its conversation was closed, its proxy is gone) → tell the human early.
    const unreachable = new Map<string, string[]>();
    // A recent interactive poll can temporarily suppress an ACP wake without setting a retry timer.
    for (const agent of new Set(this.ctx.store.allMailByStatus(["queued"]).map((mail) => mail.to_agent))) {
      if (this.doorbells.pick(agent)?.kind === "acp") this.kick(agent);
    }
    for (const m of this.ctx.store.allMailByStatus(["queued"])) {
      if (this.doorbells.acp.cancelling(m.to_agent)) continue;
      if (now - Date.parse(m.created_at) < UNREACHABLE_ALERT_MS || this.wakeAlerts.has(m.id)) continue;
      const st = this.presence.status(m.to_agent);
      if (st === "working" || st === "waiting" || this.doorbells.pick(m.to_agent)) continue;
      unreachable.set(m.to_agent, [...(unreachable.get(m.to_agent) ?? []), m.id]);
    }
    for (const [agent, ids] of unreachable) {
      for (const id of ids) this.wakeAlerts.add(id);
      this.ctx.log("agent_unreachable", { agent, mails: ids, status: this.presence.status(agent) });
      this.ctx.event(null, agent, "stuck", `${agent} 现在叫不醒（对话可能已关闭），有 ${ids.length} 封信在排队`);
      this.ctx.notifyHuman(`协作桥：${agent} 叫不醒`, `${agent} 的对话可能已关闭或断开，信在排队。请打开它的对话说一句「继续」。`);
      this.ctx.onChange();
    }
    // Queued mail that no doorbell can deliver (agent not parked / proxy gone, not polling, not busy) → ask the human.
    for (const m of this.ctx.store.allMailByStatus(["queued"])) {
      if (this.doorbells.acp.cancelling(m.to_agent)) continue;
      if (now - Date.parse(m.created_at) < ring_retry_seconds * 1000) continue;
      const st = this.presence.status(m.to_agent);
      if (st === "working" || st === "armed" || st === "waiting") continue;
      this.ctx.store.setMailStatus([m.id], "stuck");
      this.ctx.log("mail_stuck", { id: m.id, to: m.to_agent, reason: "no doorbell" });
      this.ctx.event(m.run_id, m.to_agent, "stuck", `${m.to_agent} 的门铃没有接上，「${m.subject}」送不到`);
      if (!this.wakeAlerts.has(m.id))
        this.ctx.notifyHuman("协作桥：需要你叫醒 " + m.to_agent, `${m.to_agent} 现在没有在等信。请在 ${m.to_agent} 里说「继续」。`);
    }
    const ackTimeout = ack_timeout_seconds * 1000;
    for (const m of this.ctx.store.allMailByStatus(["fetched"])) {
      if (!m.ack_required || m.overdue_flagged || now - Date.parse(m.fetched_at!) < ackTimeout) continue;
      if (m.kind === "task" && m.attempt_id && this.ctx.store.attempt(m.attempt_id)?.status === "in_progress"
        && now - (this.presence.get(m.to_agent)?.lastSeenAt ?? 0) <= ackTimeout) continue;
      // report_progress(busy_minutes): the agent said it runs a long command for this very attempt.
      if (m.kind === "task" && m.attempt_id && this.presence.busy(m.to_agent)?.attemptId === m.attempt_id) continue;
      this.ctx.store.flagOverdue(m.id);
      this.ctx.log("ack_overdue", { id: m.id, to: m.to_agent });
      this.ctx.event(m.run_id, m.to_agent, "overdue", `${m.to_agent} 取走了「${m.subject}」但一直没有确认`);
      this.ctx.notifyHuman("协作桥：确认超时", `${m.to_agent} 取走了「${m.subject}」，超过 ${Math.round(ack_timeout_seconds / 60)} 分钟没有确认。`);
    }
  }

  private mailView(m: Mail) {
    return { id: m.id, kind: m.kind, from: m.from_agent, subject: m.subject, importance: m.importance, ack_required: !!m.ack_required, sent_at: m.created_at };
  }

  fetchInbox(agent: string, sessionId: string | undefined): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const acp = this.presence.acpAgent(sessionId) === agent;
    if (this.isCancellingAcp(agent, sessionId))
      return { mails: [], instructions: "本回合正在取消。结束后，协作桥会重新提示你取信。" };
    const mails = this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]);
    const out: Result[] = [];
    for (const m of mails) {
      if (acp && this.doorbells.acp.cancelling(agent)) break;
      if (m.kind === "task") {
        const task = this.payloads.task(m);
        if (!task) {
          this.voidMails([m.id]);
          out.push({ ...this.mailView(m), void: true, note: "这个任务已停止或已被替换，忽略即可。" });
          continue;
        }
        out.push({ ...this.mailView(m), task });
      } else if (m.kind === "meeting") {
        const meeting = this.payloads.meeting(m);
        if (!meeting) {
          this.voidMails([m.id]);
          out.push({ ...this.mailView(m), void: true, note: "这一轮会议已经结束或被取消，忽略即可。" });
          continue;
        }
        out.push({ ...this.mailView(m), meeting });
      } else if (m.kind === "chat") {
        const chat = this.payloads.chat(m);
        if (!chat) {
          this.voidMails([m.id]);
          continue;
        }
        out.push({ ...this.mailView(m), chat });
      } else {
        out.push({ ...this.mailView(m), body: m.body });
      }
      this.ctx.store.setMailStatus([m.id], "fetched");
      if (m.rung_at) this.ctx.log("rung_mail_fetched", { id: m.id, agent, sinceRingMs: Date.now() - Date.parse(m.rung_at) });
    }
    if (acp) this.doorbells.acp.fetched(agent, out.filter((mail) => !mail.void).map((mail) => String(mail.id)));
    this.ctx.onChange();
    const kind = this.presence.doorbellKind(agent);
    return {
      mails: out,
      instructions: out.length
        ? "逐封处理：task 信完成后调用 submit_handoff（自动确认）；meeting 信发言后调用 submit_meeting_turn（自动确认）；chat 信不用确认，需要回答时调用 say；其他 ack_required 的信处理后调用 ack。" +
          (kind === "poll" ? "全部处理完后调用 wait_for_mail 继续等信。" : "全部处理完后结束本回合，有新信时会叫醒你。")
        : kind === "poll"
          ? "没有新信。调用 wait_for_mail 等信。"
          : "没有新信。直接结束本回合，有新信时会叫醒你。",
    };
  }

  ack(agent: string, sessionId: string | undefined, ids: string[]): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const mine = ids.filter((id) => this.ctx.store.mail(id)?.to_agent === agent);
    this.ctx.store.setMailStatus(mine, "acked");
    this.ctx.log("mail_acked", { agent, ids: mine });
    this.ctx.onChange();
    return { ok: true, acked: mine.length };
  }

  /** Poll fallback for agents without a doorbell. Keeps M0's gap metrics. */
  async waitForMail(agent: string, sessionId: string | undefined, signal: AbortSignal, onTick?: (n: number) => void): Promise<Result> {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const p = this.presence.get(agent)!;
    if (this.presence.acpAgent(sessionId) === agent) return err("后台会话处理完后直接结束本回合，有新信时会由 ACP 唤醒。");
    const started = Date.now();
    p.lastPollAt = started;
    p.waitCalls++;
    const gap = p.lastReturnAt ? started - p.lastReturnAt : undefined;
    if (gap !== undefined) {
      p.maxGapMs = Math.max(p.maxGapMs, gap);
      p.totalGapMs += gap;
      p.gapCount++;
    }
    this.ctx.log("wait_call", { agent, n: p.waitCalls, gapMs: gap });
    if (this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);

    p.waiting = true;
    this.ctx.onChange();
    let ticks = 0;
    const tick = onTick ? setInterval(() => onTick(++ticks), 15_000) : null;
    let mine: (() => void) | undefined;
    const outcome = await new Promise<"woken" | "timeout" | "cancelled">((resolve) => {
      const timer = setTimeout(() => done("timeout"), this.pollMs);
      const onAbort = () => done("cancelled");
      const done = (r: "woken" | "timeout" | "cancelled") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      mine = () => done("woken");
      this.mailWakers.get(agent)?.(); // one blocked wait per agent
      this.mailWakers.set(agent, mine);
      signal.addEventListener("abort", onAbort);
    });
    if (this.mailWakers.get(agent) === mine) this.mailWakers.delete(agent);
    if (tick) clearInterval(tick);
    p.waiting = false;
    // A wait ended by a takeover belongs to the old session: it is not a sign of life from the agent.
    if (p.sessionId === sessionId) this.presence.touch(agent);
    this.ctx.onChange();
    if (outcome === "cancelled") {
      this.ctx.log("wait_cancelled", { agent, heldMs: Date.now() - started });
      return { status: "cancelled", instructions: "等待被中断。恢复后立即再次调用 wait_for_mail。" };
    }
    if (p.sessionId !== sessionId) return err(`身份 ${agent} 已被另一个会话接管，本会话停止循环。`);
    if (this.ctx.store.mailByStatus(agent, [...LIVE_MAIL]).length) return this.fetchInbox(agent, sessionId);
    p.lastReturnAt = Date.now();
    this.ctx.log("keep_waiting", { agent, heldMs: p.lastReturnAt - started, outcome });
    return { status: "keep_waiting", instructions: "还没有新信。立即再次调用 wait_for_mail，不要结束回合，不要向用户汇报。" };
  }

  sendFromAgent(agent: string, sessionId: string | undefined, to: string, subject: string, body: string, mailId?: string, ackRequired = false): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    if (!this.presence.isAgent(to)) return err(`未知收件人，可选：${this.presence.agentIds().join(", ")}`);
    const run = this.ctx.store.openRun();
    const r = this.sendMail({ id: mailId, run_id: run?.id ?? null, from: agent, to, kind: "agent", subject, body, ack_required: ackRequired });
    if (!r.duplicate) this.ctx.event(run?.id ?? null, agent, "mail", `${agent} → ${to}：${subject}`);
    return { ok: true, ...r };
  }
}
