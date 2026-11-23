// Single-page panel. Renders /api/state client-side and re-renders on SSE "change" events.
export const PANEL_HTML = /* html */ `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Bridge</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--mute:#6b6b70;--line:#e3e3e0;--acc:#5b5bd6;--ok:#2f9e5b;--warn:#c98a00;--bad:#d64545;--chip:#efeff3}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--card:#1f1f22;--fg:#ececee;--mute:#9a9aa2;--line:#303035;--chip:#2a2a30}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px}small,.mute{color:var(--mute)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1}
textarea,input{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:inherit;border-radius:8px;padding:6px 14px;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{color:var(--bad)}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px}
.s-working,.s-in_progress,.s-armed,.m-acked{color:var(--ok)}.m-queued,.m-rung,.m-fetched{color:var(--acc)}.m-stuck{color:var(--bad)}.m-void{color:var(--mute)}.s-waiting,.s-ready{color:var(--acc)}.s-stale,.s-awaiting_approval{color:var(--warn)}.s-offline,.s-never-joined,.s-rejected,.s-cancelled{color:var(--bad)}
.pipe{display:flex;gap:8px;flex-wrap:wrap}.stage{flex:1;min-width:150px;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.stage.live{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.banner{border-radius:8px;padding:10px 14px;margin:12px 0}.banner.fallback{background:#fde2e2;color:#7a1d1d}.banner.stale{background:#fff3cd;color:#6b4e00}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-size:13px}
ul{margin:4px 0;padding-left:20px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
.chat{max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.msg{max-width:80%;padding:6px 10px;border-radius:10px;background:var(--chip);white-space:pre-wrap;word-break:break-word}
.msg.me{align-self:flex-end;background:var(--acc);color:#fff}.msg.me a{color:#fff}
.msg .meta{font-size:12px;color:var(--mute);margin-bottom:2px}.msg.me .meta,.msg.me .rc{color:#e6e6ff}.rc{font-size:12px;color:var(--mute)}
.feed div{padding:4px 0;border-bottom:1px dashed var(--line);font-size:13px}.err{color:var(--bad);font-size:13px}
a{color:var(--acc)}
</style></head><body><main>
<div class="row"><h1 class="grow">AI Bridge</h1><small id="proj"></small></div>
<div id="banner"></div>
<div class="card" id="taskcard"><div class="row"><textarea id="goal" data-keep rows="2" class="grow" placeholder="输入新目标或议题，例如：给 playground 的猜数字游戏加一个难度选项"></textarea></div>
<div class="row" style="margin-top:8px"><button class="primary" onclick="startRun()" title="按配置里的流水线（规划 → 编码 → 审查）一步步做">开始（流水线）</button>
<button onclick="startMeeting()" title="先让成员各自提案、互评，定稿出任务清单后再并行分派">开会讨论</button><span id="parts" class="mute"></span>
<button class="danger" id="stopbtn" onclick="stopRun()">停止当前任务</button><span class="err" id="taskerr"></span></div></div>
<div id="app"></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const t = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "");
const sec = (ms) => (ms == null ? "—" : (ms / 1000).toFixed(1) + "s");
const statusText = { working: "工作中", armed: "待命", waiting: "等待中", idle: "空闲", stale: "可能断网", offline: "失联", "never-joined": "未加入",
  ready: "待领取", in_progress: "进行中", awaiting_approval: "待审批", approved: "已批准", rejected: "已打回", done: "完成", cancelled: "已取消",
  active: "进行中", stopped: "已停止" };
const st = (s) => '<span class="chip s-' + s + '">' + (statusText[s] || s) + "</span>";
const list = (arr) => (arr && arr.length ? "<ul>" + arr.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "");

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
async function startRun() {
  $("#taskerr").textContent = "";
  try { await post("/api/runs", { goal: $("#goal").value }); $("#goal").value = ""; } catch (e) { $("#taskerr").textContent = e.message; }
  load();
}
async function stopRun() {
  if (!confirm("停止当前任务？进行中的阶段会被取消。")) return;
  try { await post("/api/runs/stop"); } catch (e) { $("#taskerr").textContent = e.message; }
  load();
}
async function startMeeting() {
  $("#taskerr").textContent = "";
  const participants = [...document.querySelectorAll("#parts input:checked")].map((el) => el.value);
  try { await post("/api/meetings", { topic: $("#goal").value, participants }); $("#goal").value = ""; } catch (e) { $("#taskerr").textContent = e.message; }
  load();
}
async function meetingNext(id, action) {
  const note = (document.getElementById("mnote-" + id) || {}).value || "";
  try { await post("/api/meetings/" + id + "/next", { action, note }); } catch (e) { alert(e.message); }
  load();
}
async function meetingDecide(id, action) {
  const note = (document.getElementById("mnote-" + id) || {}).value || "";
  try { await post("/api/meetings/" + id + "/decide", { action, note }); } catch (e) { alert(e.message); }
  load();
}
async function meetingCancel(id) {
  if (!confirm("取消这个会议？")) return;
  try { await post("/api/meetings/" + id + "/cancel"); } catch (e) { alert(e.message); }
  load();
}
async function decide(id, action) {
  const note = (document.getElementById("note-" + id) || {}).value || "";
  try { await post("/api/attempts/" + id + "/decide", { action, note }); } catch (e) { alert(e.message); }
  load();
}
async function releaseAgent(agent) {
  if (!confirm("释放 " + agent + " 的身份？之后新会话可以直接 join；旧会话的调用会被拒绝。")) return;
  try { await post("/api/agents/" + agent + "/release"); } catch (e) { alert(e.message); }
  load();
}
async function sendMsg(agent) {
  const el = document.getElementById("msg-" + agent);
  if (!el.value.trim()) return;
  try { await post("/api/mail", { to: agent, text: el.value }); el.value = ""; } catch (e) { alert(e.message); }
  load();
}
let replyTo = null;
async function sendChat() {
  const el = $("#chatin");
  if (!el.value.trim()) return;
  $("#chaterr").textContent = "";
  try { await post("/api/chat", { text: el.value, reply_to: replyTo && replyTo.id }); el.value = ""; setReply(null); } catch (e) { $("#chaterr").textContent = e.message; }
  load();
}
function mention(id) {
  const el = $("#chatin");
  el.value = (el.value && el.value.slice(-1) !== " " ? el.value + " " : el.value) + "@" + id + " ";
  el.focus();
}
function chatKey(e) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
}
function replyLabel() {
  return replyTo ? "　回复 #" + replyTo.id + "（" + esc(replyTo.who) + "） <a href='#' onclick='setReply(null);return false'>取消</a>" : "";
}
function setReply(id, who) {
  replyTo = id ? { id, who } : null;
  const el = $("#replyto");
  if (el) el.innerHTML = replyLabel();
  if (id) $("#chatin").focus();
}
async function answer(id) {
  const a = document.getElementById("ans-" + id).value;
  try { await post("/api/questions/" + id + "/answer", { answer: a }); } catch (e) { alert(e.message); }
  load();
}

function handoffBody(h) {
  const d = h.data;
  return '<div><b>' + esc(d.summary) + "</b></div>" +
    (d.verdict ? "<div>审查结论：" + (d.verdict === "approve" ? '<b class="s-working">通过</b>' : '<b class="s-rejected">打回</b>') + "</div>" : "") +
    (d.review_comments && d.review_comments.length ? "<div class=mute>阻塞问题</div>" + list(d.review_comments) : "") +
    (d.observations && d.observations.length ? "<div class=mute>观察（非阻塞）</div>" + list(d.observations) : "") +
    (h.scope_notes && h.scope_notes.length ? '<div class="err">范围提示</div>' + list(h.scope_notes) : "") +
    (d.done.length ? "<div class=mute>已完成</div>" + list(d.done) : "") +
    (d.todo.length ? "<div class=mute>待办</div>" + list(d.todo) : "") +
    (d.decisions.length ? "<div class=mute>关键决策</div>" + list(d.decisions.map((x) => x.what + " —— " + x.why)) : "") +
    (d.files_changed.length ? "<div class=mute>改动文件</div>" + list(d.files_changed) : "") +
    (d.notes_for_next ? "<div class=mute>给下一位</div><div>" + esc(d.notes_for_next) + "</div>" : "") +
    "<div><small>" + (h.commit_sha ? '提交 <a href="/api/commits/' + h.commit_sha + '" target="_blank">' + h.commit_sha.slice(0, 8) + "</a>"
      : h.commit_error ? '<span class="err">' + esc(h.commit_error) + "</span>" : esc(h.commit_note || "")) + "</small></div>";
}

const kindText = { proposal: "提案", critique: "互评", final: "定稿" };
const meetingStatus = { collecting: "发言中", review: "等你决定下一步", awaiting_approval: "定稿待批准", done: "已定稿", cancelled: "已取消" };
function planTable(tasks) {
  return '<table><tr><th>编号</th><th>任务</th><th>负责</th><th>审查</th><th>依赖</th><th>文件范围</th></tr>' +
    tasks.map((x) => "<tr><td>" + esc(x.id) + "</td><td><b>" + esc(x.title) + "</b>" + (x.description ? '<br><small class="mute">' + esc(x.description) + "</small>" : "") +
      "</td><td>" + esc(x.owner) + "</td><td>" + esc(x.reviewer || "—") + "</td><td>" + esc((x.depends_on || []).join("、") || "—") +
      "</td><td><small>" + esc((x.paths || []).join("、") || "—") + "</small></td></tr>").join("") + "</table>";
}
function meetingCard(m) {
  const rounds = {};
  for (const x of m.turns) (rounds[x.round] = rounds[x.round] || []).push(x);
  const spoken = (rounds[m.round] || []).map((x) => x.agent);
  const open = ["collecting", "review", "awaiting_approval"].includes(m.status);
  let h = '<div class="card" style="border-color:var(--acc)"><div class="row"><h2 class="grow">会议 #' + m.id + "：" + esc(m.topic) + "</h2>" +
    '<span class="chip">' + (meetingStatus[m.status] || m.status) + "</span></div>" +
    "<div><small>参会：" + esc(m.participants.join("、")) + " · 定稿：" + esc(m.facilitator) + (open ? " · 第 " + m.round + " 轮（" + kindText[m.round_kind] + "）" : "") +
    (m.doc_path ? " · 纪要 <code>" + esc(m.doc_path) + "</code>" : "") + "</small></div>";
  if (m.status === "collecting")
    h += '<div style="margin:6px 0"><small>本轮发言：' + m.expected.map((a) => esc(a) + (spoken.includes(a) ? ' <span class="s-working">✓</span>' : ' <span class="mute">…</span>')).join("　") + "</small></div>";
  if (m.round_note && open) h += '<div><small class="mute">你对本轮的意见：' + esc(m.round_note) + "</small></div>";
  const nums = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  for (const r of nums) {
    const last = r === nums[nums.length - 1];
    h += "<details" + (last && open ? " open" : "") + "><summary><b>第 " + r + " 轮：" + kindText[rounds[r][0].kind] + "</b> <small>（" + rounds[r].length + " 人）</small></summary>" +
      rounds[r].map((x) => '<div style="padding:6px 0 6px 10px;border-left:3px solid var(--line);margin:6px 0"><b>' + esc(x.agent) + '</b><div style="white-space:pre-wrap">' + esc(x.content) + "</div>" +
        (x.decisions && x.decisions.length ? "<div class=mute>关键决策</div>" + list(x.decisions.map((d) => d.what + " —— " + d.why)) : "") +
        (x.tasks && x.tasks.length ? "<div class=mute>" + (x.kind === "final" ? "任务清单" : "任务草案") + "</div>" + planTable(x.tasks) : "") + "</div>").join("") + "</details>";
  }
  if (open) {
    h += '<textarea id="mnote-' + m.id + '" data-keep rows="2" style="margin-top:10px" placeholder="你的意见（可选）：会带给下一轮的发言人；批准定稿时会写进每个任务"></textarea><div class="row" style="margin-top:8px">';
    if (m.status === "awaiting_approval")
      h += '<button class="primary" onclick="meetingDecide(' + m.id + ',\\'approve\\')">批准定稿，分派任务</button><button onclick="meetingDecide(' + m.id + ',\\'reject\\')">打回修改定稿</button>';
    else if (m.round_kind !== "final" && spoken.length) {
      const force = m.status === "collecting" ? "（跳过没发言的）" : "";
      h += '<button class="' + (m.status === "review" ? "primary" : "") + '" onclick="meetingNext(' + m.id + ',\\'critique\\')">再互评一轮' + force + "</button>" +
        '<button onclick="meetingNext(' + m.id + ',\\'finalize\\')">请 ' + esc(m.facilitator) + " 定稿" + force + "</button>";
    }
    h += '<button class="danger" onclick="meetingCancel(' + m.id + ')">取消会议</button></div>';
  }
  return h + "</div>";
}
function taskBoard(s) {
  const stageChips = (tk) => tk.stages.map((p) => {
    const live = tk.live && tk.live.stage_id === p.id;
    return '<span class="chip"' + (live ? ' style="outline:1px solid var(--acc)"' : "") + ">" + esc(p.id) + " · " + esc(p.agent) + (p.gate ? " 🔒" : "") +
      (live ? " " + (statusText[tk.live.status] || tk.live.status) : "") + "</span>";
  }).join(" ");
  const taskStatus = { pending: "未开始", active: "进行中", done: "完成", cancelled: "已取消" };
  const cls = { pending: "ready", active: "in_progress", done: "working", cancelled: "cancelled" };
  return '<div class="card"><div class="row"><h2 class="grow">任务 #' + s.run.id + "：" + esc(s.run.goal) + "</h2>" + st(s.run.status) + "</div>" +
    "<table><tr><th>编号</th><th>任务</th><th>负责 / 审查</th><th>依赖</th><th>文件范围</th><th>状态</th><th>阶段</th></tr>" +
    s.tasks.map((tk) => "<tr><td><b>" + esc(tk.key) + "</b></td><td>" + esc(tk.title) + "</td><td><small>" + esc(tk.owner) + " / " + esc(tk.reviewer || "—") +
      "</small></td><td><small>" + esc(tk.depends_on.join("、") || "—") + "</small></td><td><small>" + esc(tk.paths.join("、") || "—") + "</small></td><td>" +
      '<span class="chip s-' + cls[tk.status] + '">' + taskStatus[tk.status] + "</span>" +
      (tk.waiting ? '<br><small class="s-stale">' + esc(tk.waiting) + "</small>" : "") + (tk.rounds > tk.stages.length ? " <small>" + tk.rounds + " 轮</small>" : "") +
      "</td><td><small>" + stageChips(tk) + "</small></td></tr>").join("") + "</table></div>";
}

function render(s) {
  $("#proj").innerHTML = esc(s.project) + " · " + (s.git.repo ? "git" + (s.git.dirty ? "（" + s.git.dirty + " 个未提交改动）" : "") : '<span class="err">不是 git 仓库</span>');
  $("#banner").innerHTML = s.attention ? '<div class="banner ' + s.attention.kind + '">' + esc(s.attention.message) + "</div>" : "";
  const open = s.run && (s.run.status === "active" || s.run.status === "awaiting_approval");
  $("#stopbtn").style.display = open ? "" : "none";
  const partsEl = $("#parts"), partsKey = s.agents.map((a) => a.id).join(",");
  if (partsEl.dataset.key !== partsKey) {
    partsEl.dataset.key = partsKey;
    partsEl.innerHTML = "<small>参会：</small>" + s.agents.map((a) => '<label style="margin-right:6px"><input type="checkbox" value="' + esc(a.id) + '" checked style="width:auto"> <small>' + esc(a.id) + "</small></label>").join("");
  }

  let h = "";
  const m = s.meeting;
  const mOpen = m && ["collecting", "review", "awaiting_approval"].includes(m.status);
  if (m && (mOpen || Date.now() - Date.parse(m.ended_at || m.created_at) < 3600e3)) h += meetingCard(m);
  let multi = false;
  if (s.run) {
    const latest = {};
    for (const a of s.attempts) latest[a.stage_id] = a;
    multi = s.tasks.length > 1 || !!s.run.meeting_id;
    if (multi) h += taskBoard(s);
    else h += '<div class="card"><div class="row"><h2 class="grow">任务 #' + s.run.id + "：" + esc(s.run.goal) + "</h2>" + st(s.run.status) + '</div><div class="pipe">' +
      s.pipeline.map((p) => {
        const a = latest[p.id];
        const live = s.live && s.live.stage_id === p.id;
        const n = s.attempts.filter((x) => x.stage_id === p.id).length;
        return '<div class="stage' + (live ? " live" : "") + '"><b>' + esc(p.id) + "</b> <small>" + esc(p.role) + "</small><br>" +
          esc(p.agent) + (p.gate ? ' <small title="完成后需你审批">🔒</small>' : "") + "<br>" + (a ? st(a.status) : '<span class="chip">未开始</span>') +
          (n > 1 ? " <small>第 " + n + " 轮</small>" : "") + "</div>";
      }).join("") + "</div></div>";

    for (const a of s.lives.filter((x) => x.status === "awaiting_approval")) {
      const task = s.tasks.find((x) => x.id === a.task_id) || { stages: s.pipeline, key: "", title: "" };
      const ho = s.handoffs.find((x) => x.id === a.handoff_id), p = task.stages.find((x) => x.id === a.stage_id) || { id: a.stage_id };
      const target = p.on_reject || p.id, rejectFirst = ho && ho.data.verdict === "reject";
      const bApprove = '<button class="' + (rejectFirst ? "" : "primary") + '" onclick="decide(' + a.id + ',\\'approve\\')">' + (rejectFirst ? "仍然通过" : "批准，继续") + "</button>";
      const bReject = '<button class="' + (rejectFirst ? "primary" : "danger") + '" onclick="decide(' + a.id + ',\\'reject\\')">' + (rejectFirst ? "确认打回" : "打回") + "到「" + esc(target) + "」</button>";
      let fb = null;
      try { fb = a.feedback ? JSON.parse(a.feedback) : null; } catch (e) { fb = { user_requirements: [a.feedback], blocking: [], observations: [] }; }
      const fbHtml = fb && (fb.user_requirements.length || fb.blocking.length)
        ? '<div style="margin-bottom:8px"><div class=mute>本轮依据（来自「' + esc(fb.from_stage || "") + '」的打回）</div>' + list(fb.user_requirements.concat(
          fb.blocking.map((issue) => typeof issue === "string" ? issue : [issue.id, issue.problem].filter(Boolean).join(" ")))) + "</div>" : "";
      h += '<div class="card" style="border-color:var(--warn)"><h2>待你审批：' + (multi ? esc(task.key) + " " + esc(task.title) + " / " : "") + esc(a.stage_id) + "（" + esc(a.agent) + "）</h2>" + fbHtml + (ho ? handoffBody(ho) : "") +
        '<textarea id="note-' + a.id + '" data-keep rows="2" style="margin-top:10px" placeholder="备注（可选）：批准时会带给下一阶段，打回时作为修改意见"></textarea>' +
        '<div class="row" style="margin-top:8px">' + (rejectFirst ? bReject + bApprove : bApprove + bReject) + "</div></div>";
    }
  }

  const leases = s.leases.filter((l) => !l.released_at);
  if (leases.length)
    h += '<div class="card"><h2>文件租约</h2><table><tr><th>文件</th><th>持有者</th><th>任务</th><th>类型</th><th>到期</th></tr>' +
      leases.map((l) => "<tr><td><code>" + esc(l.glob) + "</code></td><td>" + esc(l.agent) + "</td><td>" + esc(l.task || "—") + "</td><td><small>" +
        (l.exclusive ? "独占" : "共享") + "</small></td><td><small>" + (l.expires_at ? (l.expired ? '<span class="s-stale">已过期（未续期）</span>' : t(l.expires_at)) : "任务结束时") +
        "</small></td></tr>").join("") + "</table></div>";

  for (const q of s.questions)
    h += '<div class="card" style="border-color:var(--acc)"><h2>' + esc(q.agent) + " 问你</h2><div>" + esc(q.question) +
      '</div><div class="row" style="margin-top:8px"><input id="ans-' + q.id + '" data-keep class="grow" placeholder="你的回答"><button class="primary" onclick="answer(' + q.id + ')">回答</button></div></div>';

  const waitingForTurn = "排队中，等对方这一轮结束";
  const rcText = { queued: "待投递", rung: "已按门铃", fetched: "已读", acked: "已读", stuck: "送不到", void: "作废" };
  const rcCls = { fetched: "s-working", acked: "s-working", stuck: "err", void: "mute" };
  const chatHtml = s.chat.map((c) => {
    const me = c.from_agent === "human";
    const rc = c.receipts.map((r) => '<span class="' + (me ? "" : rcCls[r.status] || "") + '">' + esc(r.agent) + " " + (r.waitingForTurn ? "排队中" : rcText[r.status] || r.status) + "</span>").join(" · ");
    return '<div class="msg' + (me ? " me" : "") + '"><div class="meta">' + (me ? "你" : esc(c.from_agent)) + " · " + t(c.created_at) + " · #" + c.id +
      (c.reply_to ? " · 回复 #" + c.reply_to : "") +
      (me ? "" : ' · <a href="#" data-id="' + c.id + '" data-who="' + esc(c.from_agent) + '" onclick="setReply(Number(this.dataset.id), this.dataset.who);return false">回复</a>') +
      "</div>" + esc(c.text) + (rc ? '<div class="rc">' + rc + "</div>" : "") + "</div>";
  }).join("");
  const mentionLink = (id) => '<a href="#" data-id="' + esc(id) + '" onclick="mention(this.dataset.id);return false"><small>@' + esc(id) + "</small></a>";
  h += '<div class="card"><h2>聊天</h2><div class="chat" id="chatlog">' +
    (chatHtml || '<small class="mute">用 @ 叫上成员聊几句，例如「@codex 这个接口为什么要改？」。聊天不改变任务状态。</small>') + "</div>" +
    '<div class="row"><small class="mute">叫上：</small>' + s.agents.map((a) => mentionLink(a.id)).join(" ") + " " + mentionLink("all") +
    '<span id="replyto" class="mute" style="font-size:12px">' + replyLabel() + "</span></div>" +
    '<div class="row" style="margin-top:6px;flex-wrap:nowrap"><textarea id="chatin" data-keep rows="2" class="grow" placeholder="说点什么，用 @ 指定发给谁（Ctrl+Enter 发送）" onkeydown="chatKey(event)"></textarea>' +
    '<button class="primary" onclick="sendChat()">发送</button></div><div class="err" id="chaterr"></div></div>';
  h += '<div class="card"><h2>成员</h2><table><tr><th>agent</th><th>负责</th><th>状态</th><th>门铃</th><th>信件</th><th>上次活动</th><th>发消息</th></tr>' +
    s.agents.map((a) => "<tr><td>" + esc(a.id) + "</td><td><small>" + esc(a.roles.join("、")) + "</small></td><td>" + st(a.status) +
      (a.binding ? '<br><small class="mute" title="绑定的会话 ' + esc(a.binding.session) + '">绑定于 ' + t(a.binding.since) +
        (a.binding.open ? "" : "（连接已断）") + ' <a href="#" onclick="releaseAgent(\\'' + esc(a.id) + '\\');return false">释放</a></small>' : "") +
      "</td><td><small>" +
      '<span title="门铃顺序：' + esc((a.doorbellChain || []).join(" → ")) + '">' + esc(a.doorbellLabel || a.doorbell) + "</span>" +
      (a.doorbell === "poll" ? "" : a.doorbellArmed ? ' <span class="s-working">●</span>' : ' <span class="mute">○</span>') +
      (a.lastRingVia && a.lastRingVia !== a.doorbellLabel ? '<br><span class="mute">上次按铃：' + esc(a.lastRingVia) + "</span>" : "") +
      (a.doorbellError ? '<br><span class="err">' + esc(a.doorbellError) + "</span>" : "") + "</small></td><td><small>" +
      (a.pendingMail ? "未取 " + a.pendingMail : "") + (a.stuckMail ? ' <span class="err">送不到 ' + a.stuckMail + "</span>" : "") + (a.unansweredMail ? ' <span class="err">叫不醒 ' + a.unansweredMail + "</span>" : "") +
      (a.unackedMail ? " 待确认 " + a.unackedMail : "") + (!a.pendingMail && !a.unackedMail ? "—" : "") +
      (a.waitingForTurn ? '<br><span class="s-waiting">' + waitingForTurn + (a.waitingForTurn > 1 ? " ×" + a.waitingForTurn : "") + "</span>" : "") +
      '</small></td><td><span data-ago="' + esc(a.lastSeenAt || "") + '">—</span></td>' +
      '<td><div class="row" style="flex-wrap:nowrap"><input id="msg-' + esc(a.id) + '" data-keep placeholder="给 ' + esc(a.id) + ' 发消息" style="min-width:140px">' +
      '<button onclick="sendMsg(\\'' + esc(a.id) + '\\')">发送</button></div></td></tr>').join("") + "</table></div>";

  const mailStatus = { queued: "待投递", rung: "已按门铃", fetched: "已取走", acked: "已确认", stuck: "送不到", void: "作废" };
  if (s.mail.length)
    h += '<div class="card"><h2>信件</h2><div class="feed">' + s.mail.map((m) =>
      "<div><small>" + t(m.created_at) + "</small> " + esc(m.from) + " → " + esc(m.to) + "：" + esc(m.subject) +
      ' <span class="chip m-' + m.status + '">' + (m.waitingForTurn ? waitingForTurn : mailStatus[m.status] || m.status) + (m.ring_count > 1 ? " ×" + m.ring_count : "") + "</span>" +
      (m.overdue ? ' <span class="err">确认超时</span>' : "") + "</div>").join("") + "</div></div>";

  h += '<div class="cols"><div class="card"><h2>交接记录</h2>' +
    (s.handoffs.length ? s.handoffs.slice().reverse().map((x) => '<div style="padding:8px 0;border-bottom:1px solid var(--line)"><small>' + t(x.created_at) + " · " + esc(x.agent) + " / " + esc(x.stage_id) + "</small>" + handoffBody(x) + "</div>").join("") : '<small>还没有交接</small>') +
    '</div><div><div class="card"><h2>动态</h2><div class="feed">' +
    (s.events.length ? s.events.map((e) => "<div><small>" + t(e.created_at) + "</small> " + esc(e.text) + "</div>").join("") : "<small>暂无</small>") +
    '</div></div><div class="card"><h2>共享笔记</h2><div class="feed">' +
    (s.notes.length ? s.notes.map((n) => "<div><span class=chip>" + esc(n.topic) + "</span> " + esc(n.text) + " <small>— " + esc(n.agent) + "</small></div>").join("") : "<small>暂无</small>") +
    '</div></div><div class="card"><h2>最近任务</h2><div class="feed">' +
    s.recentRuns.map((r) => "<div>#" + r.id + " " + st(r.status) + " " + esc(r.goal) + "</div>").join("") +
    "</div></div></div></div>";

  // Re-render without losing what the user is typing.
  const kept = {};
  document.querySelectorAll("#app [data-keep]").forEach((el) => (kept[el.id] = el.value));
  const focused = document.activeElement && document.activeElement.id;
  const log0 = document.getElementById("chatlog");
  const atBottom = !log0 || log0.scrollHeight - log0.scrollTop - log0.clientHeight < 40;
  $("#app").innerHTML = h;
  const log1 = document.getElementById("chatlog");
  if (log1 && atBottom) log1.scrollTop = log1.scrollHeight;
  for (const [id, v] of Object.entries(kept)) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focused) { const el = document.getElementById(focused); if (el) el.focus(); }
  tickAgo();
}

function tickAgo() {
  document.querySelectorAll("[data-ago]").forEach((el) => {
    const ts = el.getAttribute("data-ago");
    el.textContent = ts ? sec(Date.now() - Date.parse(ts)) + " 前" : "—";
  });
}

// Only rebuild the DOM when the state actually changed, so buttons aren't replaced under the cursor.
let loading = false, lastKey = "";
async function load() {
  if (loading) return; loading = true;
  try {
    const s = await (await fetch("/api/state")).json();
    const key = JSON.stringify(s);
    if (key !== lastKey) { lastKey = key; render(s); }
  } finally { loading = false; }
}
load();
new EventSource("/api/stream").onmessage = load;
setInterval(load, 5000);
setInterval(tickAgo, 1000);
</script></body></html>`;
