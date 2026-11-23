import { $, content, details, esc, rows, since } from "../dom.js";
import { folderTarget, meetingOpen, playingTarget, rejectStage, roundKind, runOpen } from "../model.js";
import { handoffCard } from "../cards/handoff.js";
import { roundCard, speakersFor } from "../cards/round.js";
import { postButton, timeTag } from "../cards/common.js";
import { cover, coverTint, folderLabel, href, icons, isClosed, localButton, memberCover, pill, statusLabel, who } from "../visuals.js";

const tabs = [["handoffs", "交接"], ["tasks", "任务"], ["discuss", "讨论"], ["minutes", "纪要"]];
const statuses = { ready: ["待领取", "run"], in_progress: ["进行中", "run"], awaiting_approval: ["待你审批", "need"],
  pending: ["排队", "done"], active: ["进行中", "run"], done: ["已完成", "ok"], cancelled: ["已取消", "done"] };

function heading(f, detail, ids, active) {
  const meeting = detail?.meeting;
  const task = detail?.tasks.find((t) => t.key === active?.task) ?? detail?.tasks[0];
  const phases = f.kind === "meeting" ? ["提案", "互评", "定稿", "批准", "执行"] : (task?.stages ?? []).map((s) => s.role);
  let step = active?.stage_index ?? 0;
  if (f.kind === "meeting") step = detail?.run ? 4 : f.status === "awaiting_approval" ? 3 : ({ proposal: 0, critique: 1, final: 2 })[meeting?.round_kind] ?? 0;
  if (f.status === "done") step = phases.length;
  const { counts } = f;
  return `<div class="fhead" style="--tint:${coverTint(f)[0]}">${cover(f)}<div class="tx"><span class="type">${folderLabel(f)}</span>
    <h1 title="${esc(f.title)}"${[...f.title].length > 28 ? ' class="long"' : ""}>${esc(f.title)}</h1><div class="meta">${f.members.map((id) => who(id, ids)).join("")}
    <span class="sep"></span><span>${f.kind === "meeting" ? counts.rounds + " 轮 · " : ""}${counts.tasks} 个任务 · ${counts.handoffs} 条交接</span>
    <span class="sep"></span><span>${esc(since(f.updated_at))}</span></div>
    <div class="phase-line" aria-label="阶段">${phases.map((p, i) => `<span class="${i < step ? "done" : i === step && !isClosed(f) ? "now" : ""}">${esc(p)}</span>`).join("")}</div></div></div>`;
}

function actions(f, detail, snapshot, options, tab, active, route) {
  const discussing = f.kind === "meeting" && !detail?.run;
  const target = active && playingTarget(active, snapshot);
  const gateCount = snapshot.lives.filter((a) => a.status === "awaiting_approval" && a.run_id === detail?.run?.id).length;
  const gate = gateCount > 0 || (discussing && f.status === "awaiting_approval");
  const primary = gate ? href(target ?? folderTarget(f.id, discussing ? "discuss" : "handoffs"), icons.check,
    { cls: "big need", label: "去审批" })
    : isClosed(f) ? localButton("followUp", icons.redo, { cls: "big run", label: "以此开新会议" })
      : href(target ?? folderTarget(f.id, discussing ? "discuss" : "tasks"), icons.jump, { cls: "big run", label: "看当前这一步" });
  let stop = "";
  if (runOpen(detail?.run)) stop = postButton("stopRun", detail.run.id, "停止工作流", { icon: icons.stop });
  else if (meetingOpen(detail?.meeting)) stop = postButton("cancelMeeting", detail.meeting.id, "取消会议", { icon: icons.stop });
  const context = gate ? "待你审批" : active ? [active.agent, active.task, active.stage].join(" · ") : statusLabel(f);
  return `<div class="fbar" style="--tint:${coverTint(f)[0]}" data-action-area>${primary}${stop}
    <details class="fbar-menu" data-detail="more-${f.id}"><summary class="ib" aria-label="更多" title="更多">⋯</summary>
    <div class="choices">${localButton("right", "打开详情", { cls: "pillbtn ghost sm", attrs: 'data-mode="detail" data-open' })}
    ${localButton("copyLink", "复制链接", { cls: "pillbtn ghost sm" })}<span class="muted" data-link-status role="status"></span></div></details>
    <span class="ctx" title="${esc(context)}">${esc(context)}</span><nav class="tabs" aria-label="文件夹分区">
    ${options.map(([key, label]) => href(folderTarget(f.id, key, undefined, key === "handoffs" ? route.before : ""),
      label + (key === "handoffs" && gateCount ? `<span class="tn">${gateCount}</span>` : ""),
      { cls: "chip", attrs: `aria-current="${tab === key ? "page" : "false"}" aria-pressed="${tab === key}"` })).join("")}</nav>
    <p class="form-error fbar-error" data-error role="alert"></p></div>`;
}

export function handoffRow(item, i, tasks) {
  const card = handoffCard(item, "handoff-" + item.id, rejectStage(item, tasks));
  const { gate, data } = item;
  const tone = gate ? pill("待你审批", "need") : data.verdict === "approve" ? pill("通过", "ok") :
    data.verdict === "reject" ? pill("打回", "bad") : pill("交接");
  const summary = [item.task?.key, item.stage_role, "·", data.summary].filter(Boolean).join(" ");
  const sha = item.commit_sha ? ` · <a href="/api/commits/${esc(item.commit_sha)}" target="_blank" rel="noopener"><code>${esc(item.commit_sha.slice(0, 8))}</code></a>` : "";
  const preview = gate && data.done?.length ? `<ul class="handoff-done">${data.done.slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "";
  return {
    ...card, className: "tr handoff-entry" + (gate ? " gate" : ""),
    heading: `<span class="no">${gate ? "●" : i + 1}</span><span class="ti">${memberCover(item.agent)}
      <b title="${esc(summary)}">${esc(summary)}</b><span>${esc(item.agent)}${sha}</span></span>
      <span class="ver">${tone}</span><span class="tm">${timeTag(item.at)}</span>`,
    body: preview + (item.commit_error ? `<p class="form-error">${esc(item.commit_error)}</p>`
      : item.commit_note ? `<p class="muted commit-note">${esc(item.commit_note)}</p>` : "") + card.body,
  };
}

function taskRow(task, ids) {
  const key = "task-" + task.id;
  const tag = statuses[task.live?.status ?? task.status];
  const paths = task.paths.length > 1 ? task.paths[0] + " 等 " + task.paths.length + " 项" : task.paths[0];
  const text = task.description ? `<p class="prose">${esc(task.description)}</p>` : "";
  const deps = task.depends_on.length ? `<p>依赖 ${esc(task.depends_on.join("、"))}</p>` : "";
  const files = task.paths.length ? `<p>文件范围</p><ul>${task.paths.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : "";
  const phases = task.stages.map((s) => `<li>${esc(s.role)} · ${esc(s.agent)}${s.id === task.live?.stage_id ? " · 当前阶段" : ""}</li>`).join("");
  return {
    key, anchor: key, className: "tr task-entry",
    heading: `<span class="no">${esc(task.key)}</span><span class="ti"><span class="cv task-cover"><b>${esc(task.key)}</b></span>
      <b title="${esc(task.title)}">${esc(task.title)}</b><span>${esc(paths ?? task.waiting)}</span></span>
      <span class="ver">${pill(...tag)}</span><span class="tm task-people">${who(task.owner, ids)}
      ${task.reviewer ? " → " + who(task.reviewer, ids) : ""}</span>`,
    body: details("task", "任务详情", '<div class="detail-body">' + text + deps + files + "<ul>" + phases + "</ul></div>", true),
  };
}

function historyRound(round, ids, cached) {
  const key = "round-" + round.meeting_id + "-" + round.round;
  return {
    key, anchor: key, className: "rnd history-round",
    heading: `<div class="round-head">${pill("第 " + round.round + " 轮 · " + roundKind[round.kind])}<h3>${round.turns.length} 人发言</h3></div>`,
    body: `<ul class="sum">${round.turns.map((t) => `<li>${who(t.agent, ids)}<span>${esc(t.summary)}</span></li>`).join("")}</ul>
      <details data-detail="history"><summary data-round="${round.round}">展开全文</summary>
      ${cached?.round ? speakersFor(cached.round, ids, true) : `<p class="${cached?.error ? "form-error" : "muted"}" role="status">
        ${esc(cached?.error || "正在取回发言…")}</p>`}</details>`,
  };
}

export function renderFolder(route, snapshot, detail, summary, problem, getRound) {
  const f = detail?.folder ?? summary;
  const message = $("#folder-message");
  message.hidden = !!detail && !problem;
  message.textContent = problem || (detail ? "" : "正在加载文件夹…");
  if (!f) {
    content($("#folder-head"));
    content($("#folder-actions"));
    for (const el of document.querySelectorAll(".folder-tab")) el.hidden = true;
    return;
  }
  const ids = snapshot.agents.map((a) => a.id);
  const active = snapshot.now_playing.find((item) => item.folder === f.id);
  const options = f.kind === "run" ? tabs.slice(0, 2) : detail?.run ? tabs : tabs.slice(2);
  const target = active && playingTarget(active, snapshot);
  const fallback = f.kind === "meeting" && !detail?.run ? "discuss" : target?.tab ?? "tasks";
  const tab = options.some(([key]) => key === route.tab) ? route.tab : fallback;
  content($("#folder-head"), heading(f, detail, ids, active));
  content($("#folder-actions"), actions(f, detail, snapshot, options, tab, active, route));
  for (const el of document.querySelectorAll(".folder-tab")) el.hidden = !detail || el.id !== "folder-" + tab;
  if (!detail) return;
  const empty = (text) => [{ key: "empty", className: "empty", body: text }];
  rows($("#handoff-items"), detail.handoffs.length ? detail.handoffs.map((h, i) => handoffRow(h, i, detail.tasks)) : empty("暂无交接"));
  const older = detail.handoffs_before ? href(folderTarget(f.id, "handoffs", undefined, detail.handoffs_before),
    "更早的交接（" + detail.handoffs_remaining + "）", { cls: "pillbtn ghost sm" }) : "";
  const newest = route.before ? href(folderTarget(f.id, "handoffs"), "返回最新", { cls: "pillbtn ghost sm" }) : "";
  content($("#handoff-pages"), older || newest ? '<div class="folder-pages">' + newest + older + "</div>" : "");
  rows($("#task-items"), detail.tasks.length ? detail.tasks.map((task) => taskRow(task, ids)) : empty("暂无任务"));
  rows($("#folder-discuss"), detail.rounds.length ? detail.rounds.map((round) => round.current
    ? roundCard({ ...round, facilitator: detail.meeting.facilitator }, ids, { folder: true, anchor: "round-" + round.meeting_id + "-" + round.round })
    : historyRound(round, ids, getRound(round.round))) : empty("暂无讨论"));
  const doc = detail.meeting?.doc_path;
  content($("#folder-minutes"), doc ? `<article class="tr minutes-file" id="minutes-file" tabindex="-1">
    <span class="no">${icons.meeting}</span><span class="prose"><code>${esc(doc)}</code></span>
    <span class="ver">${pill("已生成", "ok")}</span>${localButton("copyText", "复制路径", { cls: "pillbtn ghost sm", attrs: `data-text="${esc(doc)}"` })}
    <span class="muted" data-link-status role="status"></span></article>` :
    '<p class="empty">' + (f.status === "cancelled" ? "会议已取消，暂无纪要" : "批准定稿后生成会议纪要") + "</p>");
}
