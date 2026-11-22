import type { Attempt, Handoff, Task } from "../store.js";

export function parseDependency(dep: string): { key: string; stage: string | null } | null {
  const match = /^([A-Za-z0-9_-]+)(?:@([A-Za-z0-9_-]+))?$/.exec(dep);
  return match?.[0] === dep ? { key: match[1], stage: match[2] ?? null } : null;
}

/** Whether rejecting this attempt invalidates a reference to the given stage for new downstream work. */
export function rejectionAffectsStage(task: Task, rejected: Attempt, stage: string) {
  const from = task.stages.find((s) => s.id === rejected.stage_id);
  if (!from) return false;
  const target = task.stages.findIndex((s) => s.id === (from.on_reject ?? from.id));
  const referenced = task.stages.findIndex((s) => s.id === stage);
  return referenced >= 0 && (from.id === stage || (target >= 0 && target <= referenced));
}

export function stageDependencyHandoff(
  task: Task, stageId: string, attempts: Attempt[], getHandoff: (id: number) => Handoff | undefined,
): Handoff | undefined {
  const stage = task.stages.find((s) => s.id === stageId);
  if (!stage || task.status === "cancelled") return;
  // Attempts are in creation order. A newer human rejection can invalidate even a completed
  // attempt when it sends the task back to this stage or an earlier one.
  const latest = attempts.filter((a) => a.task_id === task.id && a.stage_id === stageId).at(-1);
  if (!latest?.handoff_id || !["done", "awaiting_approval", "approved"].includes(latest.status)) return;
  if (attempts.some((a) => a.task_id === task.id && a.id > latest.id && a.status === "rejected"
    && rejectionAffectsStage(task, a, stageId))) return;
  const handoff = getHandoff(latest.handoff_id);
  if (stage.on_reject && latest.status === "awaiting_approval" && handoff?.data.verdict !== "approve") return;
  return handoff;
}
