// Meeting room panel: one timeline for chat, meeting rounds, handoffs and approvals.
// Renders /api/state and re-renders on SSE "change" pings. Actions go through the JSON API.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad = (n) => String(n).padStart(2, "0");
  const hm = (iso) => { if (!iso) return ""; const d = new Date(iso); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const dayKey = (iso) => { const d = new Date(iso); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  const dayLabel = (iso) => {
    const k = dayKey(iso), today = dayKey(new Date().toISOString()), y = dayKey(new Date(Date.now() - 864e5).toISOString());
    return k === today ? "今天" : k === y ? "昨天" : k;
  };

  // ---- view state (survives re-renders)
  const ui = {
    filter: "all",
    targets: new Set(),
    reply: null, // { id, who }
    expanded: new Set(),
    s: null,
  };
  try { ui.filter = localStorage.getItem("room.filter") || "all"; } catch (e) {}

  // ---- members: stable colours by order
  const PALETTE = ["#E8875C", "#4FB38A", "#7AA2F7", "#D7A0E8", "#E8C35C", "#5CC8D7"];
  const color = (id) => {
    if (id === "human") return "#E8E2D4";
    const ids = ui.s ? ui.s.agents.map((a) => a.id) : [];
    const i = ids.indexOf(id);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  };
  // First letter, or the first two when another member starts with the same letter (claude / codex → Cl / Co).
  const initial = (id) => {
    if (id === "human") return "你";
    const s = String(id || "?"), first = s.slice(0, 1).toLowerCase();
    const clash = ui.s && ui.s.agents.some((a) => a.id !== s && a.id.slice(0, 1).toLowerCase() === first);
    return clash ? s.slice(0, 1).toUpperCase() + s.slice(1, 2) : s.slice(0, 1).toUpperCase();
  };
  const dot = (id, size) =>
    '<span class="dot" aria-hidden="true" style="width:' + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.42) + "px;background:" + color(id) + '">' + esc(initial(id)) + "</span>";
  const who = (id) => (id === "human" ? "你" : id);

  const STATUS = { working: "工作中", armed: "待命", waiting: "等信中", idle: "空闲", stale: "可能断网", offline: "失联", "never-joined": "未加入" };
  const STATUS_CLS = { working: "busy", armed: "ok", waiting: "ok", idle: "", stale: "warn", offline: "bad", "never-joined": "bad" };
  const ATT = { ready: "待领取", in_progress: "进行中", awaiting_approval: "待你审批", meeting: "该发言了" };
  const KIND = { proposal: "提案", critique: "互评", final: "定稿" };
  const MEETING = { collecting: "发言中", review: "等你决定下一步", awaiting_approval: "定稿待批准", done: "已定稿", cancelled: "已取消" };

  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  }

  // =============================================================== left rail
  function renderMembers(s) {
    $("#proj").textContent = s.project + " · " + (s.git.repo ? "git" + (s.git.dirty ? "（" + s.git.dirty + " 个未提交改动）" : "") : "不是 git 仓库");
    $("#members").innerHTML = s.agents.map((a) => {
      const doing = a.doing.length
        ? a.doing.map((d) => (d.task ? d.task + " " : "") + d.stage + " · " + (ATT[d.status] || d.status)).join("；")
        : a.status === "never-joined" ? "还没加入：在它的对话里粘贴启动提示词" : "没有手头的任务";
      const mail = [];
      if (a.pendingMail) mail.push("未取 " + a.pendingMail);
      if (a.waitingForTurn) mail.push('<span class="r-queue">排队 ' + a.waitingForTurn + "</span>");
      if (a.stuckMail) mail.push('<span class="r-bad">送不到 ' + a.stuckMail + "</span>");
      if (a.unansweredMail) mail.push('<span class="r-bad">叫不醒 ' + a.unansweredMail + "</span>");
      const bell = esc(a.doorbellLabel || a.doorbell) + (a.doorbell === "poll" ? "" : a.doorbellArmed ? ' <span class="armed" title="门铃已接通">●</span>' : ' <span class="unarmed" title="门铃未接通">○</span>');
      return '<div class="member">' + dot(a.id, 32) + '<div class="body">' +
        '<span class="name">' + esc(a.id) + ' <span class="chip ' + (STATUS_CLS[a.status] || "") + '">' + (STATUS[a.status] || a.status) + "</span></span>" +
        "<span>" + esc(doing) + "</span>" +
        '<span title="门铃顺序：' + esc((a.doorbellChain || []).join(" → ")) + '">门铃：' + bell + "</span>" +
        (a.doorbellError ? '<span class="err">' + esc(a.doorbellError) + "</span>" : "") +
        (mail.length ? "<span>" + mail.join(" · ") + "</span>" : "") +
        (a.binding ? '<span>绑定于 ' + hm(a.binding.since) + (a.binding.open ? "" : "（连接已断）") + ' <button type="button" class="linkbtn" data-act="release" data-agent="' + esc(a.id) + '">释放</button></span>' : "") +
        "</div></div>";
    }).join("");

    const parts = $("#parts"), key = s.agents.map((a) => a.id).join(",");
    if (parts.dataset.key !== key) {
      parts.dataset.key = key;
      parts.innerHTML = "<span>参会：</span>" + s.agents.map((a) => '<label><input type="checkbox" value="' + esc(a.id) + '" checked> ' + esc(a.id) + "</label>").join("");
    }
    const open = s.run && (s.run.status === "active" || s.run.status === "awaiting_approval");
    $("#stopbtn").hidden = !open;
  }

  // =============================================================== header
  function renderHeader(s) {
    const m = s.meeting && ["collecting", "review", "awaiting_approval"].includes(s.meeting.status) ? s.meeting : null;
    const run = s.run && (s.run.status === "active" || s.run.status === "awaiting_approval") ? s.run : null;
    let kicker = "会议室", title = "协作桥";
    if (m) { kicker = "会议 #" + m.id + " · " + (MEETING[m.status] || m.status); title = m.topic; }
    else if (run) { kicker = "任务 #" + run.id + (run.meeting_id ? " · 来自会议 #" + run.meeting_id : ""); title = run.goal; }
    $("#kicker").textContent = kicker;
    $("#title").textContent = title;
    document.title = (pendingCount(s) ? "(" + pendingCount(s) + ") " : "") + "AI Bridge 会议室";
    const n = pendingCount(s), activeTasks = (s.tasks || []).filter((t) => t.status === "active").length;
    $("#headsub").textContent = [n ? n + " 件事等你处理" : "", run && activeTasks ? activeTasks + " 个任务进行中" : ""].filter(Boolean).join(" · ");
    $("#banner").innerHTML = s.attention ? '<div class="banner ' + esc(s.attention.kind) + '">' + esc(s.attention.message) + "</div>" : "";
    const filters = [["all", "全部"], ["chat", "聊天"], ["meeting", "会议"], ["task", "任务"]];
    $("#filters").innerHTML = filters.map((f) => '<button type="button" class="pill" data-act="filter" data-v="' + f[0] + '" aria-pressed="' + (ui.filter === f[0]) + '">' + f[1] + "</button>").join("");
  }

  function pendingCount(s) {
    let n = (s.questions || []).length;
    n += (s.lives || []).filter((a) => a.status === "awaiting_approval").length;
    if (s.meeting && (s.meeting.status === "review" || s.meeting.status === "awaiting_approval")) n++;
    return n;
  }

  // =============================================================== timeline
  const clip = (key, text, n) => (ui.expanded.has(key) || text.length <= n ? text : text.slice(0, n) + "…");
  const list = (arr) => (arr && arr.length ? "<ul>" + arr.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "");
  const highlight = (text) => esc(text).replace(/@([A-Za-z0-9_-]+|all|全体|所有人)/g, '<span class="mention">@$1</span>');

  function sysItem(it) {
    return '<div class="sys"><span class="time">' + hm(it.at) + "</span><span>" + esc(it.text) + "</span></div>";
  }

  function chatItem(it) {
    const me = it.from_agent === "human";
    const byId = ui.s._chatById;
    const q = it.reply_to && byId[it.reply_to];
    const RC = { queued: ["待投递", ""], rung: ["已按门铃", ""], fetched: ["已读", "r-read"], acked: ["已读", "r-read"], stuck: ["送不到", "r-bad"], void: ["作废", ""] };
    const receipts = (it.receipts || []).map((r) => {
      const x = r.waitingForTurn ? ["排队中，等它这一轮结束", "r-queue"] : RC[r.status] || [r.status, ""];
      return '<span class="' + x[1] + '">' + esc(r.agent) + " " + x[0] + (r.read_at && x[1] === "r-read" ? " " + hm(r.read_at) : "") + "</span>";
    }).join("");
    return '<div class="msg' + (me ? " me" : "") + '">' + dot(it.from_agent, 34) + '<div class="col">' +
      '<span class="meta"><b>' + esc(who(it.from_agent)) + "</b> " + hm(it.at) + ' <span>#' + it.id + "</span>" +
      ' <button type="button" class="linkbtn" data-act="reply" data-id="' + it.id + '" data-who="' + esc(it.from_agent) + '">回复</button></span>' +
      '<div class="bubble">' + (q ? '<div class="quote">回复 ' + esc(who(q.from_agent)) + "：" + esc(q.text.length > 80 ? q.text.slice(0, 80) + "…" : q.text) + "</div>" : "") + highlight(it.text) + "</div>" +
      (receipts ? '<span class="receipts">' + receipts + "</span>" : "") +
      "</div></div>";
  }

  function planTable(tasks) {
    return '<table class="plan"><tr><th>编号</th><th>任务</th><th>负责 / 审查</th><th>依赖</th><th>文件范围</th></tr>' +
      tasks.map((x) => "<tr><td>" + esc(x.id) + "</td><td><b>" + esc(x.title) + "</b>" + (x.description ? "<br>" + esc(x.description) : "") + "</td><td>" + esc(x.owner) + " / " + esc(x.reviewer || "—") +
        "</td><td>" + esc((x.depends_on || []).join("、") || "—") + "</td><td>" + esc((x.paths || []).join("、") || "—") + "</td></tr>").join("") + "</table>";
  }

  function roundItem(it) {
    const key = "r" + it.meeting_id + "-" + it.round;
    const open = ui.expanded.has(key);
    const turns = it.turns.map((t) =>
      '<div class="turn"><span class="who">' + dot(t.agent, 22) + esc(t.agent) + '<span class="time">' + hm(t.at) + "</span></span>" +
      '<span class="text">' + esc(clip(key, t.content, 160)) + "</span>" +
      (open && t.decisions && t.decisions.length ? '<div class="details"><div class="h">关键决策</div>' + list(t.decisions.map((d) => d.what + " —— " + d.why)) + "</div>" : "") +
      (t.tasks && t.tasks.length && (open || it.kind === "final") ? '<div class="details"><div class="h">' + (it.kind === "final" ? "任务清单" : "任务草案") + "</div>" + planTable(t.tasks) + "</div>" : "") +
      "</div>").join("");
    const long = it.turns.some((t) => t.content.length > 160 || (t.decisions && t.decisions.length) || (t.tasks && t.tasks.length && it.kind !== "final"));
    let controls = "";
    if (it.status === "collecting") {
      const spoken = it.turns.map((t) => t.agent);
      controls = '<span class="sub">本轮：' + it.expected.map((a) => esc(a) + (spoken.includes(a) ? " ✓" : " …")).join("　") + "</span>" +
        '<button type="button" class="btn small" data-act="mnext" data-id="' + it.meeting_id + '" data-v="critique">跳过没发言的，再互评</button>' +
        '<button type="button" class="btn small" data-act="mnext" data-id="' + it.meeting_id + '" data-v="finalize">跳过没发言的，请 ' + esc(it.facilitator) + " 定稿</button>";
    } else if (it.status === "review") {
      controls = noteBox("mnote-" + it.meeting_id, "你的意见（可选）：会带给下一轮的发言人") +
        '<div class="actions"><button type="button" class="btn primary small" data-act="mnext" data-id="' + it.meeting_id + '" data-v="critique">再互评一轮</button>' +
        '<button type="button" class="btn small" data-act="mnext" data-id="' + it.meeting_id + '" data-v="finalize">请 ' + esc(it.facilitator) + " 定稿</button></div>";
    } else if (it.status === "awaiting_approval") {
      controls = noteBox("mnote-" + it.meeting_id, "备注（可选）：批准时会写进每个任务，打回时是修改要求") +
        '<div class="actions"><button type="button" class="btn primary small" data-act="mdecide" data-id="' + it.meeting_id + '" data-v="approve">批准定稿，分派任务</button>' +
        '<button type="button" class="btn small danger" data-act="mdecide" data-id="' + it.meeting_id + '" data-v="reject">打回修改定稿</button></div>';
    }
    if (it.status) controls += ' <button type="button" class="linkbtn" data-act="mcancel" data-id="' + it.meeting_id + '">取消会议</button>';
    return '<article class="card' + (it.status === "review" || it.status === "awaiting_approval" ? " gate" : "") + '">' +
      '<div class="cardhead"><span class="kick">会议 #' + it.meeting_id + " · 第 " + it.round + " 轮 · " + (KIND[it.kind] || it.kind) + "</span>" +
      '<span class="ttl">' + esc(it.round === 1 ? it.topic : it.kind === "final" ? it.facilitator + " 定稿" : "互评") + "</span>" +
      '<span class="time">' + hm(it.at) + "</span></div>" +
      (it.note ? '<div class="youre"><b>你的意见：</b>' + esc(it.note) + "</div>" : "") +
      '<div class="turns">' + turns + "</div>" +
      '<div class="actions">' + (long ? '<button type="button" class="linkbtn" data-act="expand" data-k="' + key + '">' + (open ? "收起" : "展开全文") + "</button>" : "") +
      (it.doc_path ? '<span class="sub">纪要 <code>' + esc(it.doc_path) + "</code></span>" : "") + "</div>" +
      (controls ? '<div class="actions">' + controls + "</div>" : "") +
      "</article>";
  }

  function noteBox(id, placeholder) {
    return '<textarea id="' + id + '" data-keep rows="2" placeholder="' + esc(placeholder) + '"></textarea>';
  }

  function handoffDetails(d, h) {
    return '<div class="details">' +
      (d.review_comments && d.review_comments.length ? '<div class="h">阻塞问题</div>' + list(d.review_comments) : "") +
      (d.observations && d.observations.length ? '<div class="h">观察（非阻塞）</div>' + list(d.observations) : "") +
      (d.done && d.done.length ? '<div class="h">已完成</div>' + list(d.done) : "") +
      (d.todo && d.todo.length ? '<div class="h">待办</div>' + list(d.todo) : "") +
      (d.decisions && d.decisions.length ? '<div class="h">关键决策</div>' + list(d.decisions.map((x) => x.what + " —— " + x.why)) : "") +
      (d.notes_for_next ? '<div class="h">给下一位</div><div>' + esc(d.notes_for_next) + "</div>" : "") +
      (h.scope_notes && h.scope_notes.length ? '<div class="h scope">范围提示（只提醒，不阻止）</div>' + list(h.scope_notes) : "") +
      "</div>";
  }

  function handoffItem(it) {
    const d = it.data, key = "h" + it.id, open = ui.expanded.has(key) || !!it.gate;
    const label = (it.task ? it.task.key + " " + it.task.title + " · " : "") + it.stage_id;
    const verdict = d.verdict ? (d.verdict === "approve" ? '<span class="verdict-ok">审查通过</span> · ' : '<span class="verdict-bad">审查打回</span> · ') : "";
    const commit = it.commit_sha ? '<a href="/api/commits/' + esc(it.commit_sha) + '" target="_blank" rel="noopener">' + esc(it.commit_sha.slice(0, 8)) + "</a>" : esc(it.commit_error || "");
    const files = (d.files_changed || []).length ? " · " + esc(d.files_changed.slice(0, 4).join("、")) + (d.files_changed.length > 4 ? " 等 " + d.files_changed.length + " 个" : "") : "";
    const hasMore = (d.done && d.done.length) || (d.todo && d.todo.length) || (d.decisions && d.decisions.length) || d.notes_for_next || (d.review_comments && d.review_comments.length) || (d.observations && d.observations.length) || (it.scope_notes && it.scope_notes.length);
    let gate = "";
    if (it.gate) {
      const g = it.gate, fb = g.feedback;
      const basis = fb && (fb.user_requirements.length || fb.blocking.length) ? '<div class="details"><div class="h">本轮依据（来自「' + esc(fb.from_stage) + "」的打回）</div>" + list(fb.user_requirements.concat(
        fb.blocking.map((issue) => typeof issue === "string" ? issue : [issue.id, issue.problem].filter(Boolean).join(" ")))) + "</div>" : "";
      const approve = '<button type="button" class="btn small ' + (g.reject_first ? "" : "primary") + '" data-act="decide" data-id="' + g.attempt_id + '" data-v="approve">' + (g.reject_first ? "仍然通过" : "批准") + "</button>";
      const reject = '<button type="button" class="btn small ' + (g.reject_first ? "primary" : "danger") + '" data-act="decide" data-id="' + g.attempt_id + '" data-v="reject">' + (g.reject_first ? "确认打回" : "打回") + "到「" + esc(g.reject_to) + "」</button>";
      gate = basis + noteBox("note-" + g.attempt_id, "备注（可选）：批准时带给后续阶段，打回时作为修改要求") + '<div class="actions">' + (g.reject_first ? reject + approve : approve + reject) + "</div>";
    }
    return '<article class="card' + (it.gate ? " gate" : "") + '">' +
      '<div class="cardhead">' + (it.gate ? '<span class="chip gate">待你审批</span>' : '<span class="kick">交接</span>') +
      '<span class="ttl">' + esc(label) + '</span><span class="time">' + hm(it.at) + "</span></div>" +
      '<div class="ho">' + dot(it.agent, 26) + '<div class="col"><span>' + verdict + "<b>" + esc(it.agent) + "</b>：" + esc(d.summary) + "</span>" +
      '<span class="files">' + commit + files + "</span>" +
      (open && hasMore ? handoffDetails(d, it) : "") +
      (!it.gate && hasMore ? '<span><button type="button" class="linkbtn" data-act="expand" data-k="' + key + '">' + (open ? "收起" : "详情") + "</button></span>" : "") +
      "</div></div>" + gate + "</article>";
  }

  function questionItem(it) {
    return '<article class="card ask"><div class="cardhead"><span class="chip gate">问你</span><span class="ttl">' + esc(it.agent) + ' 的问题</span><span class="time">' + hm(it.at) + "</span></div>" +
      '<div class="bubble">' + esc(it.question) + "</div>" +
      '<div class="inputrow"><input id="ans-' + it.id + '" data-keep placeholder="你的回答"><button type="button" class="btn primary small" data-act="answer" data-id="' + it.id + '">回答</button></div></article>';
  }

  function renderTimeline(s) {
    const items = s.timeline.filter((it) => ui.filter === "all" || it.cat === ui.filter || (it.type === "question"));
    if (!items.length) {
      return '<div class="empty">' + (ui.filter === "all"
        ? "这里会按时间显示聊天、会议发言、交接和待你审批的事。<br>在左边发起会议或任务，或者在下面 @ 成员聊几句。"
        : "这个分类下还没有内容。") + "</div>";
    }
    let out = "", lastDay = "";
    for (const it of items) {
      const dk = dayKey(it.at);
      if (dk !== lastDay) { out += '<div class="day">' + dayLabel(it.at) + "</div>"; lastDay = dk; }
      out += it.type === "chat" ? chatItem(it) : it.type === "round" ? roundItem(it) : it.type === "handoff" ? handoffItem(it) : it.type === "question" ? questionItem(it) : sysItem(it);
    }
    return out;
  }

  // =============================================================== composer
  function renderComposer(s) {
    const ids = s.agents.map((a) => a.id);
    for (const t of [...ui.targets]) if (t !== "all" && !ids.includes(t)) ui.targets.delete(t);
    const chips = [["all", "@所有人"]].concat(ids.map((id) => [id, "@" + id]));
    $("#targets").innerHTML = '<span class="sub">发给</span>' + chips.map((c) =>
      '<button type="button" class="pill" data-act="target" data-v="' + esc(c[0]) + '" aria-pressed="' + ui.targets.has(c[0]) + '">' + esc(c[1]) + "</button>").join("");
    const rb = $("#replybar");
    rb.hidden = !ui.reply;
    rb.innerHTML = ui.reply ? "回复 #" + ui.reply.id + "（" + esc(who(ui.reply.who)) + '） <button type="button" class="linkbtn" data-act="unreply">取消</button>' : "";
    $("#hint").textContent = deliveryHint(s);
  }

  function recipients(s) {
    if (ui.targets.has("all")) return s.agents.map((a) => a.id);
    const r = [...ui.targets];
    if (ui.reply && ui.reply.who !== "human" && !r.includes(ui.reply.who)) r.push(ui.reply.who);
    return r;
  }

  function deliveryHint(s) {
    const r = recipients(s);
    const typed = ($("#say").value.match(/@([A-Za-z0-9_-]+)/g) || []).map((x) => x.slice(1)).filter((x) => s.agents.some((a) => a.id === x));
    for (const t of typed) if (!r.includes(t)) r.push(t);
    if (!r.length) return "先选「发给」谁，或在消息里 @ 成员。聊天不改变任务状态，AI 不需要确认。";
    return r.map((id) => {
      const a = s.agents.find((x) => x.id === id);
      if (!a) return id;
      if (a.status === "never-joined") return id + " 还没加入，加入后才能收到";
      if (a.doing.some((d) => d.status === "in_progress") || a.waitingForTurn) return id + " 正在做任务，消息排队到这一轮结束";
      if (a.status === "offline") return id + " 不在线，消息会等它回来";
      return id + " 会被「" + (a.doorbellLabel || a.doorbell) + "」叫醒";
    }).join("；") + "。";
  }

  async function send() {
    const el = $("#say"), text = el.value.trim();
    if (!text) return;
    $("#sayerr").textContent = "";
    const mentions = ui.targets.has("all") ? ["all"] : [...ui.targets];
    try {
      await post("/api/chat", { text, mentions, reply_to: ui.reply ? ui.reply.id : undefined });
      el.value = "";
      ui.reply = null;
      autosize();
      stickBottom = true;
    } catch (e) { $("#sayerr").textContent = e.message; }
    load(true);
  }

  function autosize() {
    const el = $("#say");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight + 2, 180) + "px";
  }

  // =============================================================== right rail
  function renderRight(s) {
    let h = "";
    const m = s.meeting;
    const mRecent = m && (["collecting", "review", "awaiting_approval"].includes(m.status) || Date.now() - Date.parse(m.ended_at || m.created_at) < 6 * 3600e3);
    if (mRecent) {
      const spoken = m.turns.filter((t) => t.round === m.round).map((t) => t.agent);
      const roundsOf = (kind) => [...new Set(m.turns.filter((t) => t.kind === kind).map((t) => t.round))].length;
      const done = m.status === "done";
      const steps = [
        ["提案", m.round > 1 || m.status !== "collecting" ? "done" : "now", m.round === 1 && m.status === "collecting" ? spoken.length + "/" + m.participants.length : "✓"],
        ["互评", m.round_kind === "critique" ? (m.status === "collecting" ? "now" : "done") : m.round_kind === "final" || done ? "done" : "", roundsOf("critique") ? roundsOf("critique") + " 轮" : m.round_kind === "final" || done ? "跳过" : ""],
        ["定稿", m.round_kind === "final" ? (m.status === "collecting" ? "now" : "done") : "", m.facilitator],
        ["批准", done ? "done" : m.status === "awaiting_approval" ? "now" : "", done ? "已分派" : m.status === "cancelled" ? "已取消" : ""],
      ];
      h += '<section><h2>会议 #' + m.id + "</h2><span class=\"sub\">" + esc(m.topic) + " · " + (MEETING[m.status] || m.status) + '</span><ol class="stages">' +
        steps.map((x, i) => '<li class="' + x[1] + '"><span class="n">' + (i + 1) + "</span><span>" + x[0] + '</span><span class="h">' + esc(x[2]) + "</span></li>").join("") + "</ol></section>";
    }

    const runOpen = s.run && (s.run.status === "active" || s.run.status === "awaiting_approval");
    if (s.run) {
      const TS = { pending: "未开始", active: "进行中", done: "完成", cancelled: "已取消" };
      h += '<section><h2>任务 #' + s.run.id + (runOpen ? "" : "（" + ({ done: "已完成", stopped: "已停止" }[s.run.status] || s.run.status) + "）") + "</h2>";
      h += s.tasks.map((t) => {
        const live = t.live;
        const stage = live ? live.stage_id + " · " + live.agent : t.status === "done" ? "全部阶段完成" : "";
        const gate = live && live.status === "awaiting_approval";
        const chipCls = gate ? "gate" : t.status === "done" ? "ok" : t.status === "active" ? "busy" : "";
        const status = gate ? "待你审批" : live && live.status === "ready" ? "等它领取" : TS[t.status];
        return '<div class="task' + (gate ? " gate" : "") + '"><div class="top"><span class="key">' + esc(t.key) + "</span><span>" + esc(t.title) + "</span></div>" +
          '<div class="row">' + dot(t.owner, 18) + "<span>" + esc(t.owner) + (t.reviewer ? " / " + esc(t.reviewer) : "") + "</span>" + (stage ? "<span>· " + esc(stage) + "</span>" : "") +
          ' <span class="chip ' + chipCls + '">' + esc(status) + "</span>" + (t.rounds > t.stages.length ? ' <span class="sub">' + t.rounds + " 轮</span>" : "") + "</div>" +
          (t.paths.length ? '<span class="paths">' + esc(t.paths.join(" · ")) + "</span>" : "") +
          (t.waiting ? '<span class="wait">' + esc(t.waiting) + "</span>" : "") + "</div>";
      }).join("");
      h += "</section>";
    }

    const leases = s.leases.filter((l) => !l.released_at);
    if (leases.length)
      h += "<section><h2>文件租约</h2>" + leases.map((l) =>
        '<div class="lease' + (l.expired ? " expired" : "") + '"><code>' + esc(l.glob) + '</code><span class="holder">' + esc((l.task ? l.task + " · " : "") + l.agent) +
        (l.expires_at ? (l.expired ? " · 已过期" : " · 到 " + hm(l.expires_at)) : "") + "</span></div>").join("") + "</section>";

    if (s.notes.length)
      h += "<section><h2>共享笔记</h2>" + s.notes.slice(0, 8).map((n) => '<div class="note"><span class="chip">' + esc(n.topic) + "</span>" + esc(n.text) + ' <span class="sub">— ' + esc(n.agent) + "</span></div>").join("") + "</section>";

    if (s.recentRuns.length)
      h += "<section><h2>最近任务</h2>" + s.recentRuns.slice(0, 6).map((r) => '<div class="note">#' + r.id + " " + esc(r.goal) + ' <span class="sub">' + esc({ active: "进行中", awaiting_approval: "待审批", done: "完成", stopped: "已停止" }[r.status] || r.status) + "</span></div>").join("") + "</section>";
    $("#right").innerHTML = h || '<span class="sub">还没有会议或任务。</span>';
  }

  // =============================================================== render + load
  let stickBottom = true;
  function render(s) {
    ui.s = s;
    s._chatById = {};
    for (const it of s.timeline) if (it.type === "chat") s._chatById[it.id] = it;
    for (const c of s.chat || []) s._chatById[c.id] = s._chatById[c.id] || c;

    const kept = {};
    document.querySelectorAll("[data-keep]").forEach((el) => (kept[el.id] = el.value));
    const focused = document.activeElement && document.activeElement.id;
    const tl = $("#timeline");
    const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60;

    renderMembers(s);
    renderHeader(s);
    tl.innerHTML = renderTimeline(s);
    renderRight(s);
    renderComposer(s);

    for (const id in kept) { const el = document.getElementById(id); if (el) el.value = kept[id]; }
    if (focused) { const el = document.getElementById(focused); if (el && el !== document.activeElement) el.focus(); }
    if (nearBottom || stickBottom) tl.scrollTop = tl.scrollHeight;
    stickBottom = false;
  }

  let loading = false, again = false, lastKey = "";
  async function load(force) {
    if (loading) { again = true; return; }
    loading = true;
    try {
      const s = await (await fetch("/api/state")).json();
      const key = JSON.stringify(s);
      if (force || key !== lastKey) { lastKey = key; render(s); }
    } catch (e) {
      $("#banner").innerHTML = '<div class="banner fallback">连不上协作桥：' + esc(e.message) + "（桥停了？运行 ai-bridge start 后会自动恢复）</div>";
    } finally {
      loading = false;
      if (again) { again = false; load(); }
    }
  }

  // =============================================================== actions
  const val = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  const actions = {
    filter: (d) => { ui.filter = d.v; try { localStorage.setItem("room.filter", d.v); } catch (e) {} stickBottom = true; render(ui.s); },
    target: (d) => {
      if (d.v === "all") { ui.targets = ui.targets.has("all") ? new Set() : new Set(["all"]); }
      else { ui.targets.delete("all"); ui.targets.has(d.v) ? ui.targets.delete(d.v) : ui.targets.add(d.v); }
      renderComposer(ui.s);
    },
    reply: (d) => { ui.reply = { id: Number(d.id), who: d.who }; renderComposer(ui.s); $("#say").focus(); },
    unreply: () => { ui.reply = null; renderComposer(ui.s); },
    expand: (d) => { ui.expanded.has(d.k) ? ui.expanded.delete(d.k) : ui.expanded.add(d.k); render(ui.s); },
    release: async (d) => {
      if (!confirm("释放 " + d.agent + " 的身份？之后新会话可以直接 join；旧会话的调用会被拒绝。")) return;
      await post("/api/agents/" + encodeURIComponent(d.agent) + "/release");
    },
    decide: (d) => post("/api/attempts/" + d.id + "/decide", { action: d.v, note: val("note-" + d.id) }),
    mnext: (d) => post("/api/meetings/" + d.id + "/next", { action: d.v, note: val("mnote-" + d.id) }),
    mdecide: (d) => post("/api/meetings/" + d.id + "/decide", { action: d.v, note: val("mnote-" + d.id) }),
    mcancel: async (d) => { if (confirm("取消这个会议？")) await post("/api/meetings/" + d.id + "/cancel"); },
    answer: (d) => post("/api/questions/" + d.id + "/answer", { answer: val("ans-" + d.id) }),
    startRun: async () => { await post("/api/runs", { goal: $("#goal").value }); $("#goal").value = ""; },
    startMeeting: async () => {
      const participants = [...document.querySelectorAll("#parts input:checked")].map((el) => el.value);
      await post("/api/meetings", { topic: $("#goal").value, participants });
      $("#goal").value = "";
    },
    stopRun: async () => { if (confirm("停止当前任务？进行中的阶段会被取消。")) await post("/api/runs/stop"); },
  };
  const LOCAL = new Set(["filter", "target", "reply", "unreply", "expand"]);

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    e.preventDefault();
    const act = b.dataset.act, fn = actions[act];
    if (!fn) return;
    if (LOCAL.has(act)) return fn(b.dataset);
    const errEl = act === "startRun" || act === "startMeeting" || act === "stopRun" ? $("#starterr") : null;
    if (errEl) errEl.textContent = "";
    b.disabled = true;
    try { await fn(b.dataset); } catch (err) { errEl ? (errEl.textContent = err.message) : alert(err.message); }
    b.disabled = false;
    load(true);
  });

  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("#say").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("#say").addEventListener("input", () => { autosize(); if (ui.s) $("#hint").textContent = deliveryHint(ui.s); });

  load();
  new EventSource("/api/stream").onmessage = () => load();
  setInterval(load, 5000);
})();
