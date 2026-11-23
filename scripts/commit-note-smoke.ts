// 0.13: skip reasons (「未提交：…」) are read into commit_note and shown neutrally; real git errors keep the error style.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import YAML from "yaml";
import { PANEL_HTML } from "../src/panel.js";
import { waitFor } from "./smoke-wait.js";

interface Fixture {
  root: string;
  startDaemon(project: string): Promise<void>;
  stopDaemon(): Promise<void>;
  connect(name: string): Promise<Client>;
  call(client: Client, name: string, args: Record<string, unknown>): Promise<any>;
  api(route: string, body?: object): Promise<{ status: number; json: any }>;
  check(ok: unknown, message: string): void;
}

export async function smokeCommitNote({ root, startDaemon, stopDaemon, connect, call, api, check }: Fixture) {
  console.log("\nCommit notes (0.13)");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-smoke-commit-note-"));
  execFileSync("git", ["init", "-q", project]);
  fs.writeFileSync(path.join(project, "bridge.config.yaml"), YAML.stringify({
    agents: { owner: { doorbell: "poll" } },
    pipeline: [{ id: "implement", role: "实现", agent: "owner" }],
    git: { auto_commit: false },
    notify: { enabled: false },
  }));
  const state = async () => (await api("/api/state")).json;
  let client: Client | undefined;
  try {
    await startDaemon(project);
    client = await connect("commit-note-owner");
    await call(client, "join", { agent_id: "owner" });
    const run = (await api("/api/runs", { goal: "关闭自动提交时的交接" })).json.run_id;
    await call(client, "fetch_inbox", { agent_id: "owner" });
    const submitted = await call(client, "submit_handoff", { agent_id: "owner", summary: "没有提交" });
    const live = (await waitFor(async () => (await state()).handoffs.find((h: any) => h.run_id === run), "handoff did not appear")) as any;
    check(submitted.commit_note === "未提交：已关闭自动提交" && live.commit_note === submitted.commit_note && live.commit_error === null
      && live.commit_sha === null, "a skip reason is projected into commit_note with commit_error null; the submit reply is unchanged");
    await client.close();
    client = undefined;
    await stopDaemon();

    // Older rows: a real git error, an empty value and an old skip reason with a SHA next to it.
    const db = new DatabaseSync(path.join(project, ".bridge", "bridge.db"));
    const base = db.prepare("SELECT * FROM handoffs WHERE run_id = ?").get(run) as any;
    const insert = db.prepare(`INSERT INTO handoffs (run_id, attempt_id, stage_id, agent, data, commit_sha, commit_error, scope_notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const rows = [
      { sha: null, text: "git commit 失败：pre-commit hook exited with 1", summary: "旧的真实错误" },
      { sha: null, text: "", summary: "空字符串" },
      { sha: null, text: null, summary: "null" },
      { sha: "0123456789abcdef0123456789abcdef01234567", text: "未提交：没有文件改动", summary: "有 SHA 的旧跳过原因" },
      { sha: null, text: "未提交 没有全角冒号", summary: "前缀不精确" },
      { sha: "fedcba9876543210fedcba9876543210fedcba98", text: "git commit 失败：带 SHA 的旧错误", summary: "有 SHA 的旧错误" },
    ];
    for (const row of rows)
      insert.run(base.run_id, base.attempt_id, base.stage_id, base.agent, JSON.stringify({ ...JSON.parse(base.data), summary: row.summary }),
        row.sha, row.text, base.scope_notes, base.created_at);
    db.close();
    await startDaemon(project);
    const s = await state();
    const by = (summary: string) => s.handoffs.find((h: any) => h.data.summary === summary);
    const folder = (await api(`/api/folders/r${run}`)).json;
    const fromFolder = (summary: string) => folder.handoffs.find((h: any) => h.data.summary === summary);
    const expect: [string, string | null, string | null][] = [
      ["没有提交", null, "未提交：已关闭自动提交"],
      ["旧的真实错误", rows[0].text, null],
      ["空字符串", null, null],
      ["null", null, null],
      ["有 SHA 的旧跳过原因", null, rows[3].text],
      ["前缀不精确", rows[4].text, null],
      ["有 SHA 的旧错误", rows[5].text, null],
    ];
    check(expect.every(([summary, error, note]) => by(summary)?.commit_error === error && by(summary)?.commit_note === note
      && fromFolder(summary)?.commit_error === error && fromFolder(summary)?.commit_note === note),
      "state.handoffs and the folder read the same split: exact 「未提交：」 prefix → note, other text → error, empty → neither, regardless of SHA");

    // Rendering: the main panel's card and folder row; /v1 and /classic ship the same split.
    const { handoffCard } = await import(pathToFileURL(path.join(root, "panel/js/cards/handoff.js")).href);
    const { handoffRow } = await import(pathToFileURL(path.join(root, "panel/js/views/folder.js")).href);
    const html = (item: any) => {
      const card = handoffCard(item, "h" + item.id, null);
      const row = handoffRow(item, 0, folder.tasks ?? []);
      return String(card.heading) + String(card.body) + String(row.heading) + String(row.body);
    };
    const note = html(fromFolder("没有提交"));
    const error = html(fromFolder("旧的真实错误"));
    const neither = html(fromFolder("空字符串"));
    check(note.includes('<span class="muted">未提交：已关闭自动提交</span>') && note.includes('class="muted commit-note"')
      && !/class="(?:bad|form-error)"[^>]*>未提交/.test(note)
      && error.includes('<span class="bad">git commit 失败') && error.includes('<p class="form-error">git commit 失败')
      && !neither.includes("commit-note") && !neither.includes("form-error\">"),
      "the main panel shows a commit note in the muted style and keeps real errors red");
    // An old row can carry a SHA and a note or an error at once: the link must not hide the text (T1-B1).
    const shaNote = handoffCard(fromFolder("有 SHA 的旧跳过原因"), "h", null).heading;
    const shaError = handoffCard(fromFolder("有 SHA 的旧错误"), "h", null).heading;
    check(shaNote.includes("/api/commits/0123456789abcdef") && shaNote.includes('<span class="muted">未提交：没有文件改动</span>')
      && shaError.includes("/api/commits/fedcba9876543210") && shaError.includes('<span class="bad">git commit 失败：带 SHA 的旧错误</span>'),
      "a card with a SHA still shows the commit note or the old error next to the link");
    const v1 = fs.readFileSync(path.join(root, "panel/v1/room.js"), "utf8");
    // Both are browser scripts without a module export, so check the shipped branch text.
    // Link, error and note are three independent parts of one list, not a ternary chain where the SHA wins.
    check(/\[it\.commit_sha \?[^\n]*: "",\s*it\.commit_error \? '<span class="err">'[^\n]*: "", it\.commit_note \? '<span class="sub">'[^\n]*\]\.filter\(Boolean\)/.test(v1)
      && /\[h\.commit_sha \?[^\n]*: "",\s*h\.commit_error \? '<span class="err">'[^\n]*: "", esc\(h\.commit_note \|\| ""\)\]\.filter\(Boolean\)/.test(PANEL_HTML),
      "/v1 and /classic render the link, the error (error class) and the note (muted) independently");
  } finally {
    await client?.close().catch(() => {});
    await stopDaemon();
  }
}
