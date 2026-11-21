import path from "node:path";
import type { Addressed, Feedback, Handoff, HandoffData, HandoffSubmission, Issue, Recheck, Task } from "../store.js";

/** Numbering only advances when another issue has been recorded for this task. */
export function nextIssueNumber(task: Pick<Task, "key">, handoffs: readonly Handoff[]): number {
  const prefix = `${task.key}-B`;
  let max = 0;
  for (const handoff of handoffs) {
    for (const issue of handoff.data.issues ?? []) {
      if (issue.id?.startsWith(prefix)) max = Math.max(max, Number(issue.id.slice(prefix.length)));
    }
  }
  return max + 1;
}

function projectRelative(cwd: string): boolean {
  // Use both path conventions even when the daemon and member run on different platforms.
  if (path.win32.parse(cwd).root) return false;
  const normalized = path.posix.normalize(cwd.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../");
}

export function validateReview(data: HandoffSubmission, review: boolean, blocking: readonly Issue[]): string[] {
  const issues = data.issues ?? [];
  const rechecks = data.rechecks ?? [];
  const numbered = blocking.flatMap(({ id }) => id === null ? [] : [id]);
  const problems: string[] = [];
  if (!review && (issues.length || rechecks.length)) problems.push("只有审查阶段可以提交 issues 或 rechecks。");
  if (!data.verdict && (issues.length || rechecks.length || numbered.length)) problems.push("请填写 verdict（approve 或 reject）。");
  if (issues.length && data.review_comments?.length) problems.push("issues 和旧写法 review_comments 只能选一种提交。");
  for (const [index, { repro }] of issues.entries()) {
    if (!repro) continue;
    if (!repro.command.trim() || !repro.expect.trim()) problems.push(`issues 第 ${index + 1} 项的 repro.command 和 repro.expect 都必须填写。`);
    if (repro.cwd !== undefined && !projectRelative(repro.cwd)) problems.push(`issues 第 ${index + 1} 项的 repro.cwd 必须是项目内的相对路径。`);
  }

  const expected = new Set(numbered);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown = new Set<string>();
  for (const { id } of rechecks) {
    if (!expected.has(id)) unknown.add(id);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (!expected.size && rechecks.length) problems.push("本轮没有待核对的编号，请省略 rechecks。");
  const missing = numbered.filter((id) => !seen.has(id));
  if (missing.length) problems.push(`rechecks 缺少编号：${missing.join("、")}。`);
  if (duplicates.size) problems.push(`rechecks 重复编号：${[...duplicates].join("、")}。`);
  if (unknown.size) problems.push(`rechecks 未知编号：${[...unknown].join("、")}。`);

  const notFixed = rechecks.filter((entry) => entry.status === "not_fixed").map(({ id }) => id);
  if (data.verdict === "reject" && !notFixed.length && !issues.length && !data.review_comments?.length) {
    problems.push("reject 需要至少一个 not_fixed 的编号或一个新增阻塞问题。");
  }
  if (data.verdict === "approve" && issues.length) problems.push("approve 不能提交新增 issues，请改为 reject，或把非阻塞建议写进 observations。");
  if (data.verdict === "approve" && notFixed.length) problems.push(`approve 仍有未修复编号：${notFixed.join("、")}。`);
  return problems;
}

export function openAfter(blocking: readonly Issue[], rechecks: readonly Recheck[] = [], newIssues: readonly Issue[] = []): Issue[] {
  const notFixed = new Set(rechecks.filter((entry) => entry.status === "not_fixed").map(({ id }) => id));
  return [...blocking.filter(({ id }) => id !== null && notFixed.has(id)), ...newIssues];
}

export function checkAddressed(entries: Addressed[] | undefined, feedback: Feedback | null, scopeNotes: string[]): Addressed[] | undefined {
  if (feedback?.kind !== "rework") {
    if (entries?.length) scopeNotes.push("addressed 只用于返工交接，本轮未采用。");
    return undefined;
  }

  const expected = new Set(feedback.blocking.flatMap(({ id }) => id === null ? [] : [id]));
  const counts = new Map<string, number>();
  for (const { id } of entries ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = [...expected].filter((id) => !counts.has(id));
  const unknown = [...counts.keys()].filter((id) => !expected.has(id));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const valid = entries?.filter(({ id }) => expected.has(id) && counts.get(id) === 1);
  const unverified = valid?.filter(({ verified }) => !verified?.trim()).map(({ id }) => id);
  if (missing.length) scopeNotes.push(`addressed 未说明编号：${missing.join("、")}。`);
  if (unknown.length) scopeNotes.push(`addressed 未知编号：${unknown.join("、")}。`);
  if (duplicates.length) scopeNotes.push(`addressed 重复编号：${duplicates.join("、")}。`);
  if (unverified?.length) scopeNotes.push(`addressed 未填写 verified 的编号：${unverified.join("、")}。`);
  return valid;
}

export function reviewComment(issue: Issue, notFixed: boolean): string {
  const { id, problem, repro } = issue;
  const prefix = notFixed ? "[未修复] " : "";
  const reproduction = repro ? `（复现：${repro.command} @ ${repro.cwd || "."}；期望：${repro.expect}）` : "";
  return prefix + (id ? `${id}：` : "") + problem + reproduction;
}

export function issueSummary(data: Pick<HandoffData, "issues" | "rechecks">) {
  const previous_open = data.rechecks?.length ?? 0;
  const fixed = data.rechecks?.filter((entry) => entry.status === "fixed").length ?? 0;
  return {
    previous_open,
    fixed,
    not_fixed: previous_open - fixed,
    added: data.issues?.length ?? 0,
    late: data.issues?.filter((issue) => issue.added_in_recheck && !issue.late_reason?.trim()).length ?? 0,
  };
}
