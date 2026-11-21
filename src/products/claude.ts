// Claude's user-level MCP configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { doctorSkill, setupSkill, uninstallSkill } from "./skills.js";
import type { ProductCli, ProductProfile } from "./types.js";

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const skill = { product: "claude" as const, label: "Claude", target: path.join(os.homedir(), ".claude") };
const samePath = (a?: string, b?: string) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const run = promisify(execFile);

function isOurClaudeEntry(e: unknown, port: number) {
  if (!e) return false;
  const s = JSON.stringify(e);
  return s.includes("bridge-mcp.mjs") || s.includes(`127.0.0.1:${port}/mcp`);
}
function setup(cli: ProductCli) {
  const { refresh, node, proxy, port, info, ok, bad, writeFile } = cli;
  const j = fs.existsSync(CLAUDE_JSON) ? JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")) : {};
  j.mcpServers ??= {};
  if (refresh && !j.mcpServers.bridge) return info("Claude：没有配置 bridge，跳过（要加上就运行 ai-bridge setup）");
  const want = { type: "stdio", command: node, args: [proxy], env: {} };
  if (j.mcpServers.bridge && !isOurClaudeEntry(j.mcpServers.bridge, port)) return bad("Claude：已有一个不是协作桥的 bridge 配置，没有覆盖，请手动检查 ~/.claude.json");
  if (JSON.stringify(j.mcpServers.bridge) === JSON.stringify(want)) ok("Claude：bridge 已是最新配置");
  else {
    j.mcpServers.bridge = want;
    writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "Claude MCP 配置（stdio 转接程序）");
  }
  setupSkill(cli, skill);
}
function uninstall(cli: ProductCli) {
  uninstallSkill(cli, skill);
  const { port, info, writeFile } = cli;
  if (!fs.existsSync(CLAUDE_JSON)) return info("Claude：没有 ~/.claude.json");
  const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8"));
  if (!isOurClaudeEntry(j.mcpServers?.bridge, port)) return info("Claude：没有协作桥的配置");
  delete j.mcpServers.bridge;
  writeFile(CLAUDE_JSON, JSON.stringify(j, null, 2), "移除 Claude 的 bridge 配置");
}

function doctor(cli: ProductCli) {
  const { node, proxy, ok, bad } = cli;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).mcpServers?.bridge;
    if (entry && samePath(entry.command, node) && samePath(entry.args?.[0], proxy)) ok("Claude：bridge 指向本安装的转接程序");
    else if (entry) bad(`Claude：bridge 指向别处（${entry.url ?? entry.args?.[0] ?? "?"}）→ 运行 ai-bridge setup`);
    else bad("Claude：没有配置 bridge → 运行 ai-bridge setup");
  } catch {
    bad("Claude：读不到 ~/.claude.json");
  }
  doctorSkill(cli, skill, isOurClaudeEntry(entry, cli.port));
}

async function detectVersion() {
  if (process.platform !== "win32") return "unknown";
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version"],
      { timeout: 5_000, windowsHide: true });
    return stdout.match(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/)?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const claude: ProductProfile = {
  ids: ["claude-code", "claude"],
  label: "Claude 桌面版",
  clientNames: ["claude code", "claude-code"],
  doorbells: ["claude-socket", "poll"],
  verifiedVersions: ["6.6395", "6.28899"],
  detectVersion,
  setup,
  uninstall,
  doctor,
};
