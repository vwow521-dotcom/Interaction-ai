import { globsOverlap, normGlob } from "../git.js";
import type { PlannedTask, TaskStage } from "../store.js";
import { parseDependency } from "./stage-deps.js";

interface PreviewStage {
  task: string;
  stage: string;
  agent: string;
  kind: "work" | "review";
}

interface PreviewHint {
  code: "single_coder" | "serial_chain" | "owner_queue" | "path_serialized";
  text: string;
}

export interface PlanPreview {
  waves: { n: number; items: PreviewStage[] }[];
  members: { agent: string; work: number; review: number }[];
  total_units: number;
  hints: PreviewHint[];
}

interface SimulationTask {
  plan: PlannedTask;
  order: number;
  stages: readonly TaskStage[];
  paths: string[];
  dependencies: { upstream: SimulationTask; after: number }[];
  completed: number;
  readyAt: number | null;
}

interface Candidate {
  task: SimulationTask;
  stage: TaskStage;
}

function pathConflicts(waiter: SimulationTask, holder: SimulationTask) {
  return waiter.paths.flatMap((a) => holder.paths.filter((b) => globsOverlap(a, b)).map((b) => `${a} ↔ ${b}`));
}

/** For each ancestor, how many of its stages must finish before this task can start? */
function prerequisiteStages(tasks: SimulationTask[]) {
  const cache = new Map<SimulationTask, Map<SimulationTask, number>>();
  function visit(task: SimulationTask): Map<SimulationTask, number> {
    const known = cache.get(task);
    if (known) return known;
    const result = new Map<SimulationTask, number>();
    for (const { upstream, after } of task.dependencies) {
      result.set(upstream, Math.max(result.get(upstream) ?? 0, after));
      for (const [ancestor, stages] of visit(upstream))
        result.set(ancestor, Math.max(result.get(ancestor) ?? 0, stages));
    }
    cache.set(task, result);
    return result;
  }
  for (const task of tasks) visit(task);
  return cache;
}

/** An estimate for a validated plan. Each wave completes one stage per member. */
export function previewPlan(
  planned: readonly PlannedTask[],
  stagesFor: (task: PlannedTask) => readonly TaskStage[],
  participants: readonly string[],
): PlanPreview {
  const tasks: SimulationTask[] = planned.map((plan, order) => ({
    plan, order, stages: stagesFor(plan), paths: plan.paths.map(normGlob).filter(Boolean),
    dependencies: [], completed: 0, readyAt: null,
  }));
  const byId = new Map(tasks.map((task) => [task.plan.id, task]));
  for (const task of tasks) {
    task.dependencies = task.plan.depends_on.map((dep) => {
      const { key, stage } = parseDependency(dep)!;
      const upstream = byId.get(key)!;
      const after = stage ? upstream.stages.findIndex((s) => s.id === stage) + 1 : upstream.stages.length;
      return { upstream, after };
    });
  }
  const prerequisites = prerequisiteStages(tasks);
  const waves: PlanPreview["waves"] = [];
  const members = new Map<string, PlanPreview["members"][number]>();
  const workTasks = new Set<string>();
  const queuedOwners = new Map<string, Set<string>>();
  const leaseWaits = new Map<string, Set<string>>();
  const pending = new Set(tasks);
  const active: SimulationTask[] = [];

  while (pending.size || active.length) {
    const n = waves.length + 1;
    const blocked: { task: SimulationTask; holder: SimulationTask; paths: string[] }[] = [];

    // A task holds its leases from admission through its last stage, even when its member is busy.
    for (const task of pending) {
      if (task.dependencies.some(({ upstream, after }) => upstream.completed < after)) continue;
      const conflicts = active.map((holder) => ({ task, holder, paths: pathConflicts(task, holder) })).filter((entry) => entry.paths.length);
      if (conflicts.length) {
        blocked.push(...conflicts);
        continue;
      }
      task.readyAt = n;
      active.push(task);
      pending.delete(task);
    }

    const ready: Candidate[] = active.map((task) => ({ task, stage: task.stages[task.completed] }));
    ready.sort((a, b) => Number(!!b.stage.on_reject) - Number(!!a.stage.on_reject)
      || a.task.readyAt! - b.task.readyAt! || a.task.order - b.task.order);
    const chosen = new Map<string, Candidate>();
    const deferred: Candidate[] = [];
    for (const candidate of ready) {
      if (chosen.has(candidate.stage.agent)) deferred.push(candidate);
      else chosen.set(candidate.stage.agent, candidate);
    }
    if (!chosen.size) throw new Error("无法推算定稿分波：没有可执行的阶段。");

    if (participants.some((agent) => !chosen.has(agent))) {
      for (const { task, stage } of deferred) {
        const running = chosen.get(stage.agent)!;
        if (stage.on_reject || running.stage.on_reject || task.plan.owner !== stage.agent || running.task.plan.owner !== stage.agent) continue;
        if (prerequisites.get(task)!.has(running.task) || prerequisites.get(running.task)!.has(task)) continue;
        if (pathConflicts(task, running.task).length) continue;
        const affected = queuedOwners.get(stage.agent) ?? new Set<string>();
        affected.add(running.task.plan.id).add(task.plan.id);
        queuedOwners.set(stage.agent, affected);
      }
    }
    for (const { task, holder, paths } of blocked) {
      if (task.plan.owner === holder.plan.owner || chosen.has(task.stages[0].agent)) continue;
      const key = `${task.plan.id} 等 ${holder.plan.id}`;
      const conflicts = leaseWaits.get(key) ?? new Set<string>();
      for (const entry of paths) conflicts.add(entry);
      leaseWaits.set(key, conflicts);
    }

    const items: PreviewStage[] = [];
    for (const { task, stage } of chosen.values()) {
      const kind = stage.on_reject ? "review" : "work";
      const count = members.get(stage.agent) ?? { agent: stage.agent, work: 0, review: 0 };
      count[kind]++;
      members.set(stage.agent, count);
      if (kind === "work") workTasks.add(task.plan.id);
      items.push({ task: task.plan.id, stage: stage.id, agent: stage.agent, kind });
      task.completed++;
      task.readyAt = n + 1;
    }
    waves.push({ n, items });
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].completed === active[i].stages.length) active.splice(i, 1);
    }
  }

  const counts = [...members.values()];
  const hints: PreviewHint[] = [];
  const coders = counts.filter((m) => m.work > 0);
  const reviewers = counts.filter((m) => !m.work && m.review && participants.includes(m.agent));
  if (workTasks.size >= 2 && coders.length === 1 && reviewers.length) {
    hints.push({ code: "single_coder", text: `仅提示：只有 ${coders[0].agent} 负责实现，${reviewers.map((m) => m.agent).join("、")} 只负责审查。` });
  }
  if (tasks.length >= 3 && tasks.every((task, index) => tasks.slice(index + 1).every((other) =>
    prerequisites.get(task)!.get(other) === other.stages.length || prerequisites.get(other)!.get(task) === task.stages.length))) {
    hints.push({ code: "serial_chain", text: `仅提示：${tasks.length} 项任务必须按依赖逐个完成，共 ${waves.length} 波。` });
  }
  if (queuedOwners.size) {
    const assignments = [...queuedOwners].map(([agent, ids]) => `${agent} 名下的 ${[...ids].join("、")}`).join("；");
    hints.push({ code: "owner_queue", text: `仅提示：${assignments} 可同时领取，因同一负责人而顺延，期间有其他参会成员空闲。` });
  }
  if (leaseWaits.size) {
    const conflicts = [...leaseWaits].map(([pair, paths]) => `${pair}（${[...paths].join("、")}）`).join("；");
    hints.push({ code: "path_serialized", text: `仅提示：文件租约推迟了可开工的任务，${conflicts}。` });
  }
  return { waves, members: counts, total_units: waves.length, hints };
}
