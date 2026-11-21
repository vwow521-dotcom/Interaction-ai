import { execFile } from "node:child_process";
import type { ProductProfile } from "./types.js";

function readVersion(command: string, args: string[], env = process.env) {
  return new Promise<string>((resolve) => {
    execFile(command, args, { env, encoding: "utf8", timeout: 5000, windowsHide: true }, (error, out) => {
      resolve(error ? "unknown" : out.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/)?.[0] ?? "unknown");
    });
  });
}

export const antigravity: ProductProfile = {
  ids: ["antigravity"],
  label: "Antigravity",
  clientNames: ["antigravity-client"],
  doorbells: ["acp", "poll"],
  verifiedVersions: ["1.5.13", "1.5.14"],
  acp: { command: "%LOCALAPPDATA%\\agy\\bin\\agy.exe", pathFallback: "agy.exe", args: ["acp", "--disable-telemetry"], mcp: "stdio",
    mcpName: "bridge_acp" }, // agy can keep the already-loaded global MCP server if names collide.
  detectVersion: (command) => command ? readVersion(command, ["--version"]) : Promise.resolve("unknown"),
  setup: ({ info }) => info("Antigravity：后台成员在项目 bridge.config.yaml 配置，保留 agy 的交互式配置。"),
  uninstall: ({ info }) => info("Antigravity：保留 agy 的交互式配置。"),
  doctor: () => {},
};

export const deepseekHarness: ProductProfile = {
  ids: ["deepseek-harness"],
  label: "DeepSeek Harness",
  clientNames: ["dsh-mcp-client"],
  doorbells: ["acp", "poll"],
  verifiedVersions: ["0.2.2-rc.5"],
  acp: { mcp: "http" },
  detectVersion: (command) => command && process.platform === "win32"
    ? readVersion("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:BRIDGE_DSH_EXE).VersionInfo.FileVersion"],
        { ...process.env, BRIDGE_DSH_EXE: command })
    : Promise.resolve("unknown"),
  setup: ({ info }) => info("DeepSeek Harness：后台成员在项目 bridge.config.yaml 配置，保留 TUI 的交互式配置。"),
  uninstall: ({ info }) => info("DeepSeek Harness：保留 TUI 的交互式配置。"),
  doctor: () => {},
};
