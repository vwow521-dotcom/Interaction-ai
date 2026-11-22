import { details, esc, list } from "../dom.js";
import { label, postButton, timeTag } from "./common.js";

function block(title, content) {
  return content ? "<h4>" + esc(title) + "</h4>" + content : "";
}

function reviewStats({ data, issue_summary: counts }) {
  if (!data.verdict || !counts || (!data.issues && !data.rechecks && data.review_comments?.length)) return "";
  const { previous_open, fixed, not_fixed, added } = counts;
  const text = previous_open ? `上一轮 ${previous_open} 项：已修复 ${fixed}，未修复 ${not_fixed}；新增 ${added}` : `新增 ${added}`;
  return '<p class="muted review-stats">' + esc(text) + "</p>";
}

const statusLabels = {
  new: ["新增", "run"],
  not_fixed: ["未修复", "bad"],
  fixed: ["已修复", "good"],
  pending: ["待核对", "urgent"],
};

function issueRow(issue, status, note) {
  if (typeof issue === "string") return '<li class="prose">' + esc(issue) + "</li>";
  const { id, problem, repro, added_in_recheck, late_reason } = issue;
  const heading = id ? '<div class="row-meta"><code>' + esc(id) + "</code>" + label(...statusLabels[status]) + "</div>" : "";
  const command = repro ? '<div class="issue-repro"><pre><code>' + esc(repro.command).replace(/\r/g, "&#13;") + '</code></pre>' +
    '<div class="row-meta"><button type="button" class="pillbtn ghost sm" data-act="copyRepro">复制命令</button><span data-link-status role="status"></span></div>' +
    '<p class="muted">执行目录 <code>' + esc(repro.cwd || "项目根目录") + '</code></p><p class="prose">期望 ' + esc(repro.expect) + "</p></div>" : "";
  const reason = added_in_recheck ? (late_reason?.trim()
    ? '<p class="prose muted">上轮未发现的原因 ' + esc(late_reason) + "</p>"
    : '<p class="bad prose">未说明为何上轮没发现</p>') : "";
  return '<li class="issue-item">' + heading + '<p class="prose">' + esc(problem) + "</p>" + command + reason +
    (note ? '<p class="prose muted">复查说明 ' + esc(note) + "</p>" : "") + "</li>";
}

function issueList(rows) {
  return rows?.length ? '<ul class="issue-list">' + rows.join("") + "</ul>" : "";
}

function selfChecks(entries) {
  return issueList(entries?.map(({ id, how, verified }) => '<li class="issue-item"><code>' + esc(id) +
    '</code><p class="prose">' + esc(how) + '</p>' + (verified?.trim() ? '<p class="prose muted">验证 ' + esc(verified) + "</p>" : "") + "</li>"));
}

export function handoffCard(item, anchor, rejectStage) {
  const { data, gate } = item;
  const stage = [item.task?.key, item.stage_role].filter(Boolean).join(" ");
  const verdict = data.verdict === "approve" ? label("审查通过", "good") : data.verdict === "reject" ? label("建议打回", "bad") : "";
  const mark = gate ? label("待你审批", "urgent") : label("交接");
  const commit = item.commit_sha
    ? '<a href="/api/commits/' + esc(item.commit_sha) + '" target="_blank" rel="noopener">提交 ' + esc(item.commit_sha.slice(0, 8)) + "</a>"
    : item.commit_error ? '<span class="bad">' + esc(item.commit_error) + "</span>" : "";
  const basis = gate?.feedback;
  const rechecks = new Map(data.rechecks?.map((entry) => [entry.id, entry]));
  const requirements = list(basis?.user_requirements) + issueList(basis?.blocking?.map((issue) =>
    issueRow(issue, rechecks.get(issue.id)?.status ?? "pending")));
  const reviewIssues = [
    ...(data.rechecks ?? []).map(({ issue, status, note }) => issueRow(issue, status, note)),
    ...(data.issues ?? []).map((issue) => issueRow(issue, "new")),
  ];
  const long = data.summary.length > 180;
  const summary = '<p class="prose">' + esc(long ? data.summary.slice(0, 180) + "…" : data.summary) + "</p>";
  const body = block("交接摘要", long && '<p class="prose">' + esc(data.summary) + "</p>")
    + block("本轮要求", requirements)
    + block("阻塞问题", issueList(reviewIssues) || list(data.review_comments))
    + block("返工自查", selfChecks(data.addressed))
    + block("观察", list(data.observations))
    + block("已完成", list(data.done))
    + block("待办", list(data.todo))
    + block("关键决策", list(data.decisions?.map((d) => d.what + " — " + d.why)))
    + block("给下一位", data.notes_for_next && '<p class="prose">' + esc(data.notes_for_next) + "</p>")
    + block("改动文件", list(data.files_changed))
    + block("范围提示", list(item.scope_notes));
  const upstreamLabels = { reworking: "正在返工", superseded: "已有更新", cancelled: "已取消" };
  const upstream = (gate?.upstream_state ?? []).flatMap(({ dep, state }) =>
    Object.hasOwn(upstreamLabels, state) ? [`依据的 ${dep} ${upstreamLabels[state]}`] : []);
  let control;
  if (gate) {
    const approve = postButton("decide", gate.attempt_id, gate.reject_first ? "仍然通过" : "批准", {
      value: "approve", style: gate.reject_first ? "" : "primary",
    });
    const stage = rejectStage ?? gate.reject_to;
    const reject = postButton("decide", gate.attempt_id, (gate.reject_first ? "确认打回" : "打回") + "到「" + stage + "」", {
      value: "reject", style: "danger", confirm: "打回这份交接并重新分派「" + stage + "」？",
    });
    control = {
      field: { key: "gate-" + gate.attempt_id, label: "交接审批备注", placeholder: "备注或修改要求（可选）", inline: true },
      buttons: gate.reject_first ? reject + approve : approve + reject,
    };
  }
  return {
    key: "handoff-" + item.id, anchor, className: gate ? "card decision-card" : "card handoff-card",
    heading: '<div class="row-meta">' + mark + verdict + timeTag(item.at) + "</div>" +
      "<h3>" + esc(stage) + " 交接</h3>" + summary +
      '<div class="card-byline">' + esc(item.agent) + (commit ? " · " + commit : "") + "</div>",
    control,
    body: block("上游依赖", list(upstream)) + reviewStats(item) +
      (body ? details("handoff", "查看交接详情", '<div class="detail-body">' + body + "</div>") : ""),
  };
}
