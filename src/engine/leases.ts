// Ownership and expiry of file leases.
import { globsOverlap, normGlob } from "../git.js";
import type { Lease, Task } from "../store.js";
import { err, type EngineContext, type Result } from "./context.js";
import type { Postman } from "./postman.js";
import type { Presence } from "./presence.js";
import type { Scheduler } from "./scheduler.js";

interface CancellationHold {
  task: Task;
  paths: string[];
  leaseIds: Set<number>;
  turns: Set<Promise<void>>;
}

export class Leases {
  private readonly cancellationHolds = new Map<number, CancellationHold>();

  constructor(
    private readonly ctx: EngineContext,
    private readonly presence: Presence,
    private readonly postman: Postman,
    private readonly scheduler: Pick<Scheduler, "currentTask" | "schedule" | "resumeAfterCancellation">,
  ) {
    // The previous daemon's in-memory holds cannot release leases on a stopped run after a restart.
    const stoppedRuns = new Set<number>();
    for (const lease of ctx.store.openLeases()) {
      if (lease.run_id !== null && ctx.store.run(lease.run_id)?.status === "stopped") stoppedRuns.add(lease.run_id);
    }
    for (const runId of stoppedRuns) ctx.store.releaseLeasesOfRun(runId);
  }

  holdForCancellation(task: Task, done: Promise<void>) {
    let hold = this.cancellationHolds.get(task.id);
    if (!hold) {
      const active = this.activeLeases().filter((lease) => lease.task_id === task.id);
      hold = {
        task, paths: [...task.paths, ...active.map((lease) => lease.glob)],
        leaseIds: new Set(active.map((lease) => lease.id)), turns: new Set(),
      };
      this.cancellationHolds.set(task.id, hold);
    }
    if (hold.turns.has(done)) return;
    hold.turns.add(done);
    const current = hold;
    void done.then(() => {
      current.turns.delete(done);
      if (current.turns.size) return;
      this.cancellationHolds.delete(task.id);
      if (this.ctx.store.run(task.run_id)?.status === "stopped") this.ctx.store.releaseLeasesOfTask(task.id);
      this.scheduler.resumeAfterCancellation();
      this.ctx.onChange();
    });
  }

  cancellationConflict(task: Task): Task | undefined {
    for (const hold of this.cancellationHolds.values()) {
      // A task without declared paths can write anywhere in the project.
      if (hold.task.id === task.id || !hold.task.paths.length || !task.paths.length
        || task.paths.some((path) => hold.paths.some((heldPath) => globsOverlap(path, heldPath)))) return hold.task;
    }
  }

  releaseRun(runId: number) {
    for (const lease of this.ctx.store.openLeases()) {
      if (lease.run_id === runId && !this.heldForCancellation(lease)) this.ctx.store.releaseLease(lease.id);
    }
  }

  private heldForCancellation(lease: Lease) {
    return lease.task_id !== null && this.cancellationHolds.get(lease.task_id)?.leaseIds.has(lease.id);
  }

  leaseTaskPaths(task: Task) {
    for (const g of task.paths) this.ctx.store.addLease({ run_id: task.run_id, task_id: task.id, agent: task.owner, glob: normGlob(g), exclusive: 1, reason: `任务 ${task.key}`, expires_at: null });
  }

  /** Unreleased leases that still count, including those retained while a task's ACP turn cancels. */
  activeLeases(): Lease[] {
    const now = Date.now();
    return this.ctx.store.openLeases().filter((l) => !l.expires_at || Date.parse(l.expires_at) > now || this.heldForCancellation(l));
  }

  /** Leases held by someone else that collide with `globs`. A lease collides when either side is exclusive. */
  leaseConflicts(globs: string[], who: { agent: string; taskId?: number | null; exclusive: boolean }) {
    const out: { glob: string; lease_id: number; lease_glob: string; held_by: string; task: string | null; expires_at: string | null }[] = [];
    if (!globs.length) return out;
    for (const l of this.activeLeases()) {
      if (who.taskId != null && l.task_id === who.taskId) continue;
      if (l.agent === who.agent && (l.task_id === null || l.task_id === who.taskId)) continue;
      if (!who.exclusive && !l.exclusive) continue;
      for (const g of globs)
        if (globsOverlap(g, l.glob))
          out.push({ glob: g, lease_id: l.id, lease_glob: l.glob, held_by: l.agent, task: l.task_id ? (this.ctx.store.task(l.task_id)?.key ?? null) : null, expires_at: l.expires_at });
    }
    return out;
  }

  reservePaths(agent: string, sessionId: string | undefined, globs: string[], exclusive = true, ttlSeconds?: number, reason = ""): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    if (this.postman.isCancellingAcp(agent, sessionId)) return err("后台回合正在取消，请在下一回合申请文件租约。");
    const clean = [...new Set(globs.map(normGlob).filter(Boolean))];
    if (!clean.length) return err("globs 不能为空。");
    const run = this.ctx.store.openRun();
    const task = this.scheduler.currentTask(agent);
    const conflicts = this.leaseConflicts(clean, { agent, taskId: task?.id ?? null, exclusive });
    if (conflicts.length) {
      for (const holder of new Set(conflicts.map((c) => c.held_by))) {
        if (holder === agent) continue;
        const mine = conflicts.filter((c) => c.held_by === holder);
        this.postman.sendMail({
          id: `conflict-${agent}-${mine.map((c) => c.lease_id).join("_")}-${clean.join(",")}`.slice(0, 200),
          run_id: run?.id ?? null,
          from: "bridge",
          to: holder,
          kind: "system",
          subject: `文件冲突：${agent} 想改 ${mine.map((c) => c.lease_glob).join("、")}`,
          body:
            `${agent}${task ? `（任务 ${task.key}）` : ""} 想租下 ${clean.join("、")}${reason ? `，原因：${reason}` : ""}，和你持有的租约冲突：` +
            mine.map((c) => `${c.lease_glob}${c.task ? `（任务 ${c.task}）` : ""}`).join("、") +
            "。如果你已经不需要这部分文件，调用 release_paths 释放；否则用 send_mail 和对方商量。不需要回复这封信。",
        });
      }
      this.ctx.log("lease_conflict", { agent, globs: clean, conflicts });
      this.ctx.event(run?.id ?? null, agent, "lease", `${agent} 申请 ${clean.join("、")} 冲突：${conflicts.map((c) => `${c.lease_glob}（${c.held_by}）`).join("、")}`);
      return {
        granted: false,
        conflicts,
        instructions: "这些文件已被其他成员占用，没有租给你。不要修改它们；已通知占用者。可以先做别的部分，或用 send_mail 和占用者商量。",
      };
    }
    const ttl = ttlSeconds ?? this.ctx.cfg.leases.default_ttl_seconds;
    const expires = new Date(Date.now() + ttl * 1000).toISOString();
    const open = this.ctx.store.openLeases().filter((l) => l.agent === agent && l.expires_at);
    const granted: Result[] = [];
    for (const g of clean) {
      const same = open.find((l) => l.glob.toLowerCase() === g.toLowerCase() && l.task_id === (task?.id ?? null));
      const renewed = same && this.ctx.store.renewLease(same.id, exclusive, expires);
      const id = same?.id ?? this.ctx.store.addLease({ run_id: run?.id ?? null, task_id: task?.id ?? null, agent, glob: g, exclusive: exclusive ? 1 : 0, reason, expires_at: expires });
      granted.push({ lease_id: id, glob: g, exclusive: renewed ? !!renewed.exclusive : exclusive, expires_at: renewed?.expires_at ?? expires, renewed: !!renewed });
    }
    this.ctx.log("lease_granted", { agent, globs: clean, task: task?.key, ttl });
    this.ctx.event(run?.id ?? null, agent, "lease", `${agent} 租下 ${clean.join("、")}${exclusive ? "（独占）" : "（共享）"}，${Math.round(ttl / 60)} 分钟`);
    return {
      granted: true,
      leases: granted,
      instructions: `已租给你，${Math.round(ttl / 60)} 分钟后到期（再调用一次即续期）。${task ? `任务 ${task.key} 结束时自动释放。` : ""}用完可调用 release_paths 提前释放。`,
    };
  }

  releasePaths(agent: string, sessionId: string | undefined, globs?: string[]): Result {
    const be = this.presence.bindingError(agent, sessionId);
    if (be) return err(be);
    const want = globs?.length ? new Set(globs.map((g) => normGlob(g).toLowerCase())) : null;
    const mine = this.ctx.store.openLeases().filter((l) => l.agent === agent && l.expires_at
      && !this.heldForCancellation(l) && (!want || want.has(l.glob.toLowerCase())));
    for (const l of mine) this.ctx.store.releaseLease(l.id);
    this.ctx.log("lease_released", { agent, ids: mine.map((l) => l.id) });
    if (mine.length) this.ctx.event(null, agent, "lease", `${agent} 释放了 ${mine.map((l) => l.glob).join("、")}`);
    const run = this.ctx.store.openRun();
    if (run) this.scheduler.schedule(run.id);
    return {
      ok: true,
      released: mine.map((l) => l.glob),
      note: "任务自带的租约（任务的 paths）在任务结束时自动释放，这里不能提前释放。",
    };
  }
}
