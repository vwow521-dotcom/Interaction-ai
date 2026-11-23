import { createActions } from "./actions.js";
import { $, content, copyToken, esc, findCopyBox, rememberCopyFallback, restoreDrafts, saveDraft, setDraftProject, showCopyFallback, since } from "./dom.js";
import { folderTarget, meetingOpen, officeTarget, runFolder, runOpen } from "./model.js";
import { readRoute, router } from "./router.js";
import { renderHome, renderLibrary, renderPlayer, renderRight } from "./shell.js";
import { createState } from "./state.js";
import { createComposer, renderChat } from "./views/chat.js";
import { renderFolder } from "./views/folder.js";
import { renderMemberDetails, renderOffice } from "./views/office.js";
import { elapsed, folderLabel, href, icons } from "./visuals.js";

const shell = $("#shell");
const main = $("#main");
const launch = $("#launch-dialog");
const mobile = matchMedia("(max-width: 767px)");
const narrow = matchMedia("(max-width: 1180px)");
const systemTheme = matchMedia("(prefers-color-scheme: light)");
const preferences = (key, value) => {
  try {
    if (value !== undefined) sessionStorage.setItem("bridge." + key, JSON.stringify(value));
    return JSON.parse(sessionStorage.getItem("bridge." + key) ?? "null");
  } catch { return value ?? null; }
};

function setTheme(value) {
  document.documentElement.dataset.theme = value;
}
let manualTheme;
try { manualTheme = localStorage.getItem("bridge.theme"); } catch { /* Follow the system. */ }
setTheme(manualTheme || (systemTheme.matches ? "light" : "dark"));
systemTheme.addEventListener("change", () => { if (!manualTheme) setTheme(systemTheme.matches ? "light" : "dark"); });

const chevron = (d) => `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const themeIcon = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5v11a5.5 5.5 0 0 1 0-11z"/></svg>';
for (const [selector, icon] of [
  ["#home-link", icons.home], ["#office-link", icons.office], ["#chat-link", icons.chat],
  ['[data-act="back"]', chevron("M10 3 5 8l5 5")], ['[data-act="forward"]', chevron("m6 3 5 5-5 5")],
  ['[data-act="theme"]', themeIcon], ['.rp-h [data-mode="detail"]', icons.detail],
]) $(selector).innerHTML = icon;
for (const button of document.querySelectorAll('[data-act="close"],.rp-h [data-mode="none"]')) button.innerHTML = icons.close;
for (const item of document.querySelectorAll("[data-icon]")) item.innerHTML = icons[item.dataset.icon];

let route = { view: "home" };
let mode = narrow.matches ? "none" : "detail";
let mobilePane = "main";
let libFilter = "all";
let homeFilter = "all";
let project;
let selectedMember;
let anchor = "";
let mobileFocus;
let libraryMore = true;
let libraryError = "";
let loadingMore = false;
let launchMode = preferences("launchMode") === "run" ? "run" : "meeting";
const library = new Map();
const searchDetails = new Map();
const olderRounds = new Map();
const scrolls = new Map();
const keptFocus = new Map();

let detail;
let detailError = "";
let folderRequest;
let detailKey = "";
const folderKey = () => route.view === "folder" ? route.id + "/" + (route.before || "") : "";
const sorted = () => [...library.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));

const state = createState((error) => {
  const banner = $("#connection-error");
  banner.hidden = !error;
  banner.textContent = error ? "协作桥连接中断 · " + error.message : "";
}, refreshFolder);
const post = createActions(state.refresh);
restoreDrafts(document);
const composer = createComposer(post);

async function get(path, signal) {
  const response = await fetch(path, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}

function rememberFiles(data) {
  const old = searchDetails.get(data.folder.id);
  const files = old?.files ?? new Map();
  for (const h of data.handoffs) for (const path of h.data.files_changed ?? []) {
    files.set(path, folderTarget(data.folder.id, "handoffs", "handoff-" + h.id));
  }
  searchDetails.set(data.folder.id, { ...data, files });
}

function cancelFolderRequest() {
  const active = folderRequest;
  folderRequest = null;
  active?.controller.abort();
}

function refreshFolder() {
  const key = folderKey();
  if (!key) return;
  if (folderRequest) {
    folderRequest.pending = true;
    return;
  }
  const id = route.id;
  const controller = new AbortController();
  const active = folderRequest = { controller, pending: false };
  const query = new URLSearchParams();
  if (route.before) query.set("handoffs_before", route.before);
  get("/api/folders/" + id + (query.size ? "?" + query : ""), controller.signal).then((data) => {
    if (folderRequest !== active || folderKey() !== key) return;
    detail = data;
    detailKey = key;
    detailError = "";
    library.set(id, data.folder);
    rememberFiles(data);
    renderPage();
    // A shared chat link can point at an older handoff. Resolve it after any pending refresh.
    if (active.pending) return;
    const handoff = /^handoff-(\d+)$/.exec(anchor);
    if (!route.before && handoff && !data.handoffs.some((h) => h.id === Number(handoff[1]))) {
      const before = Number(handoff[1]) + 1;
      if (Number.isSafeInteger(before)) navigate({ ...route, tab: "handoffs", before: String(before) }, true);
    }
  }).catch((error) => {
    if (folderRequest !== active || folderKey() !== key) return;
    detailError = error.message;
    renderPage();
  }).finally(() => {
    if (folderRequest !== active) return;
    folderRequest = null;
    if (active.pending && folderKey() === key) refreshFolder();
  });
}

async function expandRound(id, value) {
  const key = id + "/" + value;
  if (olderRounds.get(key)?.round || olderRounds.get(key)?.loading) return;
  olderRounds.set(key, { loading: true });
  try {
    const data = await get("/api/folders/" + id + "?round=" + value);
    const round = data.rounds.find((r) => r.round === Number(value) && r.full);
    if (!round) throw new Error("这一轮的发言不存在");
    olderRounds.set(key, { round });
  } catch (error) { olderRounds.set(key, { error: error.message }); }
  if (route.id === id) renderPage();
}

function drawLibrary(snapshot) {
  const more = libraryMore && snapshot.folders_head.length === 8;
  renderLibrary(snapshot, sorted(), route, libFilter, more, libraryError);
}

function scrollKey(r) {
  return [r.view, r.id, r.tab, r.before].join("/");
}
function showLayout() {
  shell.dataset.right = mode;
  shell.dataset.m = mobilePane;
  const view = ["workspace", "meeting"].includes(route.view) ? "home" : route.view;
  for (const el of main.querySelectorAll(":scope > section")) el.hidden = el.id !== "view-" + view;
  for (const name of ["home", "office", "chat"]) $("#" + name + "-link").setAttribute("aria-current", name === view ? "page" : "false");
}
function jumpToAnchor() {
  if (!anchor) return;
  const node = document.getElementById(anchor);
  if (!node || !main.contains(node) || !node.getClientRects().length) return;
  $("[data-reveal]", node)?.setAttribute("open", "");
  node.scrollIntoView({ block: "start" });
  node.focus({ preventScroll: true });
  anchor = "";
}

function renderPage() {
  const snapshot = state.current;
  if (!snapshot) return;
  const current = detailKey === folderKey() ? detail : null;
  const folder = route.id && library.get(route.id);
  if (route.view === "folder")
    renderFolder(route, snapshot, current, folder, detailError, (n) => olderRounds.get(route.id + "/" + n));
  if (route.view === "home" || route.view === "workspace") renderHome(snapshot, homeFilter);
  if (route.view === "office") renderOffice(snapshot);
  if (route.view === "chat") renderChat(snapshot);
  drawLibrary(snapshot);
  const folders = new Map(sorted().map((f) => [f.id, f]));
  renderRight(snapshot, current, folder, mode, folders);
  renderPlayer(snapshot, folders, mode, mobilePane, route);
  jumpToAnchor();
}
function finishLegacyRoute() {
  const s = state.current;
  const id = meetingOpen(s.meeting) ? "m" + s.meeting.id : runOpen(s.run) ? runFolder(s.run) : s.folders_head[0]?.id;
  navigate(id ? folderTarget(id) : { view: "home" }, true);
}
const navigate = router((next, nav) => {
  const prevKey = scrollKey(route);
  const prevView = route.view;
  const from = folderKey();
  if (document.activeElement?.matches("[data-keep]") && main.contains(document.activeElement)) {
    keptFocus.set(prevKey, document.activeElement.dataset.keep);
  }
  scrolls.set(prevKey, main.scrollTop);
  route = next;
  anchor = route.anchor;
  if (from !== folderKey()) {
    cancelFolderRequest();
    detailError = "";
  }
  if (mobile.matches && mobilePane === "right") mode = "none";
  mobilePane = next.view === "workspace" ? "lib" : "main";
  $('[data-act="back"]').disabled = !nav.back;
  $('[data-act="forward"]').disabled = !nav.forward;
  showLayout();
  if (route.view === "meeting") {
    if (state.current) queueMicrotask(finishLegacyRoute);
    return;
  }
  const changed = prevKey !== scrollKey(route);
  if (changed || prevView !== route.view) main.scrollTop = 0;
  const targetAnchor = anchor;
  renderPage();
  if (!targetAnchor && changed) main.scrollTop = scrolls.get(scrollKey(route)) ?? 0;
  const key = keptFocus.get(scrollKey(route));
  if (!targetAnchor && key) {
    const field = [...main.querySelectorAll("[data-keep]")].find((el) => el.dataset.keep === key && el.getClientRects().length);
    field?.focus({ preventScroll: true });
  }
  if (state.current && (from !== folderKey() || !detail || detailError)) refreshFolder();
});

async function moreFolders() {
  if (loadingMore || !libraryMore) return;
  const leaf = sorted().at(-1);
  if (!leaf) return;
  loadingMore = true;
  const fromProject = project;
  try {
    const q = new URLSearchParams({ limit: 20, before: leaf.updated_at + "/" + leaf.id });
    const page = await get("/api/folders?" + q);
    if (project !== fromProject) return;
    for (const f of page.folders) if (!library.has(f.id)) library.set(f.id, f);
    libraryMore = !!page.next_before;
    libraryError = "";
  } catch (error) { libraryError = error.message; }
  finally {
    loadingMore = false;
    if (state.current) drawLibrary(state.current);
  }
}

function showRight(next, force = false) {
  const active = document.activeElement;
  if (mobile.matches && active?.matches("[data-keep]") && main.contains(active)) mobileFocus = active;
  mode = next !== "none" && next === mode && !force ? "none" : next;
  mobilePane = mode !== "none" && mobile.matches ? "right" : route.view === "workspace" ? "lib" : "main";
  showLayout();
  renderPage();
  if (mode === "none" && mobileFocus?.getClientRects().length) mobileFocus.focus({ preventScroll: true });
}
mobile.addEventListener("change", () => {
  if (mode !== "none") showRight(mode, true);
});
document.addEventListener("mousedown", (event) => {
  if (event.button === 0 && !mobile.matches && event.target.closest('[data-act="right"]')
    && document.activeElement?.matches("[data-keep]") && main.contains(document.activeElement)) event.preventDefault();
});

function showLaunchMode(next) {
  launchMode = next;
  preferences("launchMode", next);
  for (const choice of $("#launch-modes").children) choice.setAttribute("aria-pressed", String(choice.dataset.mode === next));
  $("#launch-meeting").hidden = next !== "meeting";
  $("#launch-run").hidden = next !== "run";
}
showLaunchMode(launchMode);

function openDialog(dialog) {
  if (dialog.open) return;
  $("dialog[open]")?.close();
  dialog.showModal();
}
function openLaunch(folder) {
  const field = $("#meeting-topic");
  field.dataset.keep = folder ? "meeting-topic-" + folder.id : "meeting-topic";
  restoreDrafts($("#launch-meeting"));
  if (folder) {
    if (!field.value) saveDraft(field, folder.title);
    showLaunchMode("meeting");
  }
  openDialog(launch);
  if (folder) field.focus();
}
function showMember() {
  const s = state.current;
  if (!s || !$("#member-dialog").open) return;
  renderMemberDetails(s.agents.find((a) => a.id === selectedMember), s.agents.map((a) => a.id),
    s.timeline.find((it) => it.type === "delivery" && it.agent === selectedMember));
}

async function copyWake(button) {
  const token = copyToken(button.closest(".wake-copy"));
  const phrase = button.dataset.wake;
  try {
    await navigator.clipboard.writeText(phrase);
    rememberCopyFallback(token, null);
    const box = findCopyBox(token);
    if (!box) return;
    $("input", box).hidden = true;
    $("[data-copy-status]", box).textContent = "已复制";
  } catch {
    const box = findCopyBox(token);
    if (!box) return;
    const fallback = { value: phrase, status: "已选中，请手动复制" };
    rememberCopyFallback(token, fallback);
    const active = document.activeElement;
    showCopyFallback(box, fallback, { focus: active === document.body || box.contains(active) });
  }
}
async function copyText(button, value, fallback = value) {
  const status = $("[data-link-status]", button.closest(".minutes-file, .choices, .issue-repro"));
  try {
    await navigator.clipboard.writeText(value);
    status.textContent = "已复制";
  } catch { status.textContent = fallback; }
}

const local = {
  back() { history.back(); }, forward() { history.forward(); },
  right(button) { showRight(button.dataset.mode, button.hasAttribute("data-open")); },
  launch() { openLaunch(); },
  launchMode(button) { showLaunchMode(button.dataset.mode); (launchMode === "run" ? $("#run-goal") : $("#meeting-topic")).focus(); },
  followUp() { openLaunch(library.get(route.id)); },
  close(button) { button.closest("dialog").close(); },
  member(button) {
    selectedMember = button.dataset.agent;
    openDialog($("#member-dialog"));
    showMember();
  },
  message(button) {
    composer.pick(button.dataset.agent);
    navigate({ view: "chat" });
    $("#chat-text").focus({ preventScroll: true });
  },
  target(button) { composer.target(button.dataset.agent); },
  reply(button) { composer.replyTo(Number(button.dataset.id), button.dataset.agent); },
  unreply() { composer.unreply(); },
  copyWake,
  copyLink(button) { void copyText(button, location.href); },
  copyText(button) { void copyText(button, button.dataset.text); },
  copyRepro(button) {
    const command = $("pre code", button.closest(".issue-repro")).textContent;
    void copyText(button, command, "剪贴板不可用，请选中命令复制");
  },
  libFilter(button) { libFilter = button.dataset.filter; if (state.current) drawLibrary(state.current); },
  homeFilter(button) { homeFilter = button.dataset.filter; if (state.current) renderHome(state.current, homeFilter); },
  moreFolders,
  fullGroup(button) {
    libFilter = homeFilter;
    if (mobile.matches) navigate({ view: "workspace" });
    else if (state.current) drawLibrary(state.current);
    const wanted = button.dataset.group;
    const selector = wanted === "run" ? '[data-group="need"],[data-group="run"]' : '[data-group="done"]';
    $(selector, $("#lib-list"))?.scrollIntoView({ block: "start" });
  },
  theme() {
    manualTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    setTheme(manualTheme);
    try { localStorage.setItem("bridge.theme", manualTheme); } catch { /* This page keeps the selected theme. */ }
  },
};

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-keep]")) saveDraft(event.target);
});
main.addEventListener("focusin", (event) => {
  if (event.target.matches("[data-keep]")) keptFocus.set(scrollKey(route), event.target.dataset.keep);
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-jump]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    link.closest("dialog")?.close();
    if (link.closest("#search-results")) closeSearch();
    if (mobile.matches && mobilePane === "right") showRight("none");
    navigate(readRoute(link.hash));
    return;
  }
  if (!event.target.closest(".search-wrap")) closeSearch();
  const summary = event.target.closest("summary[data-round]");
  if (summary && !summary.closest("details").open && route.id) void expandRound(route.id, summary.dataset.round);
  const button = event.target.closest("button[data-act],button[data-post]");
  if (!button || button.type === "submit") return;
  if (button.dataset.post) void post(button.dataset.post, button);
  else local[button.dataset.act]?.(button);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || $("dialog[open]")) return;
  if (!$("#search-results").hidden) closeSearch();
  else if (mode !== "none" && narrow.matches) showRight("none");
});

for (const form of [$("#launch-meeting"), $("#launch-run")]) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("[data-post]", form);
    const meeting = button.dataset.post === "startMeeting";
    const result = await post(button.dataset.post, button);
    if (!result) return;
    launch.close();
    navigate(folderTarget(meeting ? "m" + result.meeting_id : "r" + result.run_id));
  });
}

function closeSearch() {
  $("#search-results").hidden = true;
  $("#search-text").setAttribute("aria-expanded", "false");
}
function renderSearch() {
  const results = $("#search-results");
  const q = $("#search-text").value.trim().toLowerCase();
  if (!q || !state.current) return closeSearch();
  const out = new Map();
  const add = (name, kind, target) => {
    if (!name || !name.toLowerCase().includes(q)) return;
    out.set([name, target.id, target.anchor].join("/"), href(target, "<b>" + esc(name) + "</b><small>" + esc(kind) + "</small>"));
  };
  for (const f of sorted()) add(f.title, folderLabel(f), folderTarget(f.id));
  for (const member of state.current.agents) add(member.id, "成员", officeTarget(member.id));
  const taskFiles = (id, tasks) => {
    for (const t of tasks) {
      const target = folderTarget(id, "tasks", "task-" + t.id);
      add(t.title, "任务 " + t.key, target);
      for (const path of t.paths) add(path, "任务文件范围", target);
    }
  };
  const s = state.current;
  if (s.run) taskFiles(runFolder(s.run), s.tasks);
  for (const lease of s.leases) {
    const target = lease.run_id && s.run?.id === lease.run_id ?
      folderTarget(runFolder(s.run), "tasks", lease.task_id && "task-" + lease.task_id) : officeTarget(lease.agent);
    add(lease.glob, "租约", target);
  }
  for (const data of searchDetails.values()) {
    taskFiles(data.folder.id, data.tasks);
    add(data.meeting?.doc_path, "会议纪要", folderTarget(data.folder.id, "minutes", "minutes-file"));
    for (const [path, target] of data.files) add(path, "交接改动", target);
  }
  content(results, [...out.values()].slice(0, 12).join("") || "<p>没有找到</p>");
  results.hidden = false;
  $("#search-text").setAttribute("aria-expanded", "true");
}
$("#search-text").addEventListener("input", renderSearch);
$("#search-text").addEventListener("focus", renderSearch);
function firstSearchResult() {
  const first = $("#search-results a");
  if (first && !$("#search-results").hidden) first.click();
}
$("#search-text").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  firstSearchResult();
});
$("#search").addEventListener("submit", (event) => {
  event.preventDefault();
  firstSearchResult();
});

$("#participants").addEventListener("change", () => {
  preferences("participants", [...$("#participants").querySelectorAll("input:not(:checked)")].map((el) => el.value));
});
$("#facilitator").addEventListener("change", (event) => preferences("facilitator", event.target.value));
state.subscribe((s) => s.agents.map((a) => a.id), (ids) => {
  const excluded = preferences("participants") ?? [];
  content($("#participants"), ids.map((id) =>
    `<label><input type="checkbox" value="${esc(id)}" ${excluded.includes(id) ? "" : "checked"}> ${esc(id)}</label>`).join(""));
  content($("#facilitator"), '<option value="">使用默认成员</option>' + ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join(""));
  const prior = preferences("facilitator");
  $("#facilitator").value = ids.includes(prior) ? prior : "";
});
state.subscribe((s) => s, (snapshot) => {
  if (project !== snapshot.project) {
    cancelFolderRequest();
    detail = null;
    detailKey = "";
    detailError = "";
    library.clear();
    searchDetails.clear();
    olderRounds.clear();
    libraryMore = true;
    project = snapshot.project;
    setDraftProject(project);
  }
  for (const f of snapshot.folders_head) library.set(f.id, f);
  $("#project").textContent = project;
  const version = $("#daemon-version");
  const daemon = snapshot.daemon;
  version.hidden = !daemon;
  version.textContent = daemon ? `v${daemon.version} · ${daemon.commit === "dev" ? "开发版" : daemon.commit.slice(0, 7)}` : "";
  version.title = daemon ? `${daemon.commit} · ${daemon.channel} · ${daemon.started_at}` : "";
  $("#project").title = project;
  $("#launch-project").textContent = project + (snapshot.git.repo ? " · Git" : " · 未初始化 Git");
  document.title = (snapshot.inbox.length ? "(" + snapshot.inbox.length + ") " : "") + "AI Bridge 协作面板";
  composer.update(snapshot.agents);
  if (!$("#search-results").hidden) renderSearch();
  if (route.view === "meeting") finishLegacyRoute();
  else renderPage();
  showMember();
});

setInterval(() => {
  for (const timestamp of document.querySelectorAll("time[data-since]")) timestamp.textContent = since(timestamp.dateTime);
  for (const timestamp of document.querySelectorAll("time[data-elapsed]")) timestamp.textContent = elapsed(timestamp.dateTime);
}, 15_000);
state.start();
