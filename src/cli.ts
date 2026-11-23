// ai-bridge command line: install/uninstall client configuration, set up a project, start the daemon, diagnose.
//
//   ai-bridge setup                 configure Claude + Codex to use this installed copy (idempotent)
//   ai-bridge uninstall             remove everything `setup` (and older manual installs) added
//   ai-bridge init <dir>            prepare a project folder (git, bridge.config.yaml)
//   ai-bridge start [dir] [--port]  run the bridge for a project (default: current folder)
//   ai-bridge doctor                check that everything is consistent and current (incl. against GitHub)
//   ai-bridge update [--channel release|main] [--ref <branch|tag|commit>]
//                                   reinstall from GitHub, then refresh only the clients already configured
//
// Every file change makes a timestamped backup first (<file>.bak-ai-bridge-<time>). `--dry-run` shows changes only.
// `setup --refresh` touches only entries that already exist, so a client you removed on purpose stays removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAt, latestRelease, inspectAsset } from "./release-asset.js";
import { installedVersion } from "./diagnostics/github.js";
import { acpChecks } from "./diagnostics/acp.js";
import { probe } from "./diagnostics/probe.js";
import { products, versionWarning } from "./products/index.js";
import type { ProductCli } from "./products/types.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8"));
const VERSION: string = PKG_JSON.version;
/** "owner/name" from package.json repository, used by `update` and `doctor`. */
const REPO: string | undefined = String(PKG_JSON.repository?.url ?? PKG_JSON.repository ?? "").match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
const BUILD = buildAt(PKG, import.meta.url.endsWith(".ts"));
const short = (c?: string | null) => (c ? c.slice(0, 7) : "未知");
const NODE = process.execPath;
const PROXY = path.join(PKG, "bin", "bridge-mcp.mjs");
const PORT = 7878;
const BASE = (process.env.BRIDGE_URL ?? "http://127.0.0.1:" + PORT).replace(/\/$/, "");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("dry-run");
const REFRESH = flag("refresh");

const ok = (m: string) => console.log("  ✓ " + m);
const bad = (m: string) => console.log("  ✗ " + m);
const info = (m: string) => console.log("  · " + m);

function backup(file: string) {
  if (!fs.existsSync(file) || DRY) return;
  const stamp = new Date().toISOString().replace(/\D/g, "");
  fs.copyFileSync(file, `${file}.bak-ai-bridge-${stamp}`);
}
function writeFile(file: string, content: string, what: string) {
  if (DRY) return info(`[dry-run] 会写入 ${file}（${what}）`);
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  ok(`${what} → ${file}`);
}
function removeFile(file: string, what: string) {
  if (DRY) return info(`[dry-run] 会删除 ${file}（${what}）`);
  backup(file);
  fs.rmSync(file);
  ok(`已删除 ${what}：${file}`);
}

const cli: ProductCli = {
  packageDir: PKG,
  node: NODE,
  proxy: PROXY,
  port: PORT,
  refresh: REFRESH,
  project: opt("project"),
  ok,
  bad,
  info,
  writeFile,
  removeFile,
};

// ---------- commands ----------

function setup() {
  console.log(`协作桥 ${VERSION}（${short(BUILD.commit)}）：${REFRESH ? "刷新已有的客户端配置" : "配置客户端"}（安装位置 ${PKG}）`);
  for (const product of products) product.setup(cli);
  if (REFRESH) return;
  const hints = [
    ...products.flatMap((p) => p.setupHint ? [p.setupHint] : []),
    "Claude 和 Codex 都新开对话（已开的对话还在用旧配置）。",
    "为项目启动协作桥：ai-bridge start <项目目录>",
  ];
  console.log(`
接下来：
${hints.map((hint, i) => `  ${i + 1}. ${hint}`).join("\n")}
  随时运行 ai-bridge doctor 检查配置。`);
}

function uninstall() {
  console.log("协作桥：移除客户端配置");
  for (const product of products) product.uninstall(cli);
  console.log("\n各项目里的 .bridge/ 数据和 bridge.config.yaml 没有动。要移除程序本身：npm uninstall -g ai-bridge");
}

function init() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  console.log(`协作桥：准备项目 ${dir}`);
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, "bridge.config.yaml");
  if (fs.existsSync(cfg)) ok("已有 bridge.config.yaml，保持不变");
  else writeFile(cfg, fs.readFileSync(path.join(PKG, "bridge.config.example.yaml"), "utf8"), "流水线配置 bridge.config.yaml");
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let isRepo = false;
  try {
    isRepo = git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {}
  if (!isRepo) {
    if (DRY) info("[dry-run] 会 git init 并提交 bridge.config.yaml");
    else {
      git("init", "-q", "-b", "main");
      git("add", "bridge.config.yaml");
      git("commit", "-q", "-m", "Initial setup for AI bridge");
      ok("已 git init 并做了初始提交（协作桥的自动提交需要已有的历史）");
    }
  } else {
    let hasCommit = true;
    try {
      git("rev-parse", "HEAD");
    } catch {
      hasCommit = false;
    }
    if (hasCommit) ok("已是 git 仓库");
    else bad("是 git 仓库但还没有任何提交：请先做一个初始提交");
  }
  console.log(`\n启动：ai-bridge start ${dir}`);
}

async function start() {
  const dir = path.resolve(args[1] && !args[1].startsWith("--") ? args[1] : ".");
  process.argv = [process.argv[0], "daemon", "--project", dir, "--port", opt("port") ?? String(PORT)];
  await import("./daemon.js");
}

async function bridgeRunning(): Promise<any | null> {
  try {
    const r = await fetch(BASE + "/api/state", { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Latest commit of `ref` on GitHub, or null when offline / not reachable. */
function remoteCommit(ref: string): string | null {
  if (!REPO) return null;
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${REPO}.git`, ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
    });
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

async function update() {
  if (!REPO) throw Error("package.json 缺少 GitHub 仓库地址");
  const channel = flag("channel") ? opt("channel") : flag("ref") ? "main" : "release";
  const ref = opt("ref") ?? "main";
  if (channel !== "release" && channel !== "main") throw Error("--channel 需要 release 或 main");
  if (flag("ref") && (channel !== "main" || !opt("ref") || ref.startsWith("-"))) throw Error("--ref 仅适用于 main 通道，且需要指定分支、标签或提交号");
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  const installedDir = path.join(root, "ai-bridge");
  const installed = buildAt(installedDir);
  const release = channel === "release" ? await latestRelease(REPO, PKG_JSON.name) : null;
  if (!flag("force") && installed.channel === channel && !installed.dirty) {
    if (release && fs.existsSync(path.join(installedDir, "package.json")) &&
        JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8")).version === release.version)
      return ok("已安装最新正式 Release " + release.version);
    if (!release && installed.commit && remoteCommit(ref) === installed.commit) return ok("已安装最新提交 " + short(installed.commit));
  }
  if (DRY) return info(`[dry-run] 会${release ? "下载并核对 " + release.filename : "检出并构建 " + ref}，然后全局安装、setup --refresh、doctor`);
  const running = await bridgeRunning();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-update-"));
  try {
    let file: string;
    if (release) {
      file = path.join(tmp, release.filename);
      const response = await fetch(release.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Error("安装包下载失败：HTTP " + response.status);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      inspectAsset(file, PKG_JSON.name, release.version);
    } else {
      const src = path.join(tmp, "src");
      execFileSync("git", ["init", "-q", src]);
      execFileSync("git", ["fetch", "-q", "--depth", "1", "--", `https://github.com/${REPO}.git`, ref], { cwd: src });
      execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: src });
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_(global|location|prefix)$/i.test(k)));
      env.BRIDGE_BUILD_CHANNEL = "main";
      execSync("npm ci --no-audit --no-fund", { cwd: src, env, stdio: "inherit" });
      execSync("npm pack --ignore-scripts --pack-destination ..", { cwd: src, env, stdio: "inherit" });
      const packed = fs.readdirSync(tmp).find(f => f.endsWith(".tgz"));
      if (!packed) throw Error("npm pack 没有产出安装包");
      file = path.join(tmp, packed);
    }
    fs.renameSync(file, path.join(tmp, "candidate.tgz"));
    for (const command of ["npm install -g ./candidate.tgz", "ai-bridge setup --refresh", "ai-bridge doctor"])
      execSync(command, { cwd: tmp, stdio: "inherit" });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n更新完成。Claude 和 Codex 新开的对话会用新版本（已开的对话还在用旧的转接程序）。");
  if (running) console.log(`桥正在为 ${running.project} 运行，还是旧代码：停掉后重新 ai-bridge start 一次。`);
}

function proxyResponds(): Promise<string | null> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete env.CLAUDE_CODE_MESSAGING_TOKEN;
    const p = spawn(NODE, [PROXY], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env });
    let out = "";
    const done = (r: string | null) => {
      clearTimeout(timer);
      p.kill();
      resolve(r);
    };
    const timer = setTimeout(() => done(null), 8000);
    p.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j.id === 2) done((j.result?.tools ?? []).map((t: any) => t.name).join(","));
        } catch {}
      }
    });
    const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-bridge-doctor", version: VERSION } } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    }, 300);
  });
}

async function doctor() {
  console.log(`协作桥 ${VERSION} 体检（安装位置 ${PKG}）`);
  const print = { ok, bad, info };
  const projectDir = path.resolve(cli.project ?? ".");
  if (flag("probe")) {
    const checks = await Promise.all([probe(bridgeRunning), acpChecks(projectDir, VERSION, true)]);
    for (const check of checks.flat()) print[check.state](check.text);
    return;
  }
  const built = `${short(BUILD.commit)}${BUILD.dirty ? "，构建时有未提交改动" : ""}${BUILD.builtAt ? `，构建于 ${BUILD.builtAt.slice(0, 16).replace("T", " ")}` : ""}`;
  info(`CLI v${VERSION} · ${built} · ${BUILD.channel}`);
  if (BUILD.channel === "main") {
    const install = await installedVersion(REPO, remoteCommit("main"), BUILD, built);
    print[install.state](install.text.replace("运行 ai-bridge update", "运行 ai-bridge update --channel main"));
  } else if (BUILD.channel === "release" && REPO) {
    try {
      const latest = await latestRelease(REPO, PKG_JSON.name);
      (VERSION === latest.version ? ok : info)(`安装版 v${VERSION}，最新 Release v${latest.version}`);
    } catch (error) { info(String(error)); }
  }
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}：需要 22.13 或更新（内置 SQLite）`);

  const desktop = products.filter((product) => !product.acp);
  const versions = await Promise.all(desktop.map((product) => product.detectVersion()));
  for (const [i, product] of desktop.entries()) {
    product.doctor(cli);
    const version = versions[i];
    const warning = versionWarning(product, version);
    const detail = product.label + " 版本 " + version;
    if (warning) {
      const line = detail + " · " + warning;
      info(process.stdout.isTTY ? "\x1b[33m" + line + "\x1b[0m" : line);
    } else if (version === "unknown") info(detail);
    else ok(detail + "（门铃已验证）");
  }
  for (const check of await acpChecks(projectDir, VERSION, false)) print[check.state](check.text);

  const tools = await proxyResponds();
  if (tools === null) bad("转接程序没有响应");
  else if (tools.includes("fetch_inbox")) ok("转接程序正常，桥在运行，工具齐全");
  else ok("转接程序正常（桥没在运行，所以只有占位工具；ai-bridge start <项目> 后自动切换）");

  const s = await bridgeRunning();
  console.log("运行中的桥");
  if (s?.daemon) {
    const d = s.daemon;
    info(`v${d.version} · ${d.commit} · ${d.channel}，启动于 ${d.started_at}，项目 ${d.project}，端口 ${d.port}`);
    if (d.version === VERSION && d.commit === BUILD.commit) ok("安装版与运行版一致");
    else bad("安装版和运行版不同，请停掉 ai-bridge 后重新 ai-bridge start");
  } else if (s) info("运行中的桥版本未知（0.12 或更早），建议重启后核对");
  else info("桥没有在 " + BASE + " 运行");
}

function help() {
  console.log(`ai-bridge ${VERSION}

  ai-bridge setup                 配置 Claude 和 Codex 使用本安装（可反复运行）
  ai-bridge uninstall             移除 setup 加的所有配置（也会清理旧的手动配置）
  ai-bridge init <目录>           准备一个项目：bridge.config.yaml、git
  ai-bridge start [目录] [--port 7878]
                                  为项目启动协作桥（面板 http://127.0.0.1:7878/）
                                  端口已被占用时请使用已有面板或另选空闲端口
  ai-bridge doctor                检查配置是否一致、安装是否和 GitHub 上的最新版一致
  ai-bridge doctor --probe [--project <目录>]
                                  检查门铃和格式；ACP 只发 initialize，不建会话
  ai-bridge update [--channel release|main] [--ref <分支|标签|提交>] [--force]
                                  从 GitHub 重新安装，然后只刷新已经配置了 bridge 的客户端
  ai-bridge setup --refresh       只更新已有的配置，不新增（update 会自动调用）

  通用选项：--dry-run 只显示会做什么，不改文件。`);
}

const cmd = args[0];
switch (cmd) {
  case "setup":
  case "install":
    setup();
    break;
  case "uninstall":
    uninstall();
    break;
  case "init":
    init();
    break;
  case "start":
    await start();
    break;
  case "doctor":
    await doctor();
    break;
  case "update":
  case "upgrade":
    try { await update(); } catch (error) { bad(String(error)); process.exitCode = 1; }
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`${VERSION} (${short(BUILD.commit)})`);
    break;
  default:
    help();
}
