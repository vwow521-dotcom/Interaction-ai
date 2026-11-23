import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const numeric = "(?:0|[1-9]\\d*)";
const identifier = "(?:" + numeric + "|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
export const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
export const assetName = (name: string, version: string) => name.replace(/^@/, "").replace("/", "-") + "-" + version + ".tgz";
type Build = { commit?: string; channel?: "main" | "release" | "dev"; dirty?: boolean; builtAt?: string };
export function buildAt(root: string, source = false): Build {
  if (source) return { commit: "dev", channel: "dev" };
  let build: Build = {};
  try { build = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8")); } catch {}
  return { ...build, channel: build.channel ?? (build.commit ? "main" : "dev") };
}
export function inspectAsset(file: string, name: string, version: string) {
  const read = (entry: string) => execFileSync("tar", ["-xOzf", file, "package/" + entry], { encoding: "utf8" });
  const pkg = JSON.parse(read("package.json"));
  const build = JSON.parse(read("dist/build-info.json"));
  if (pkg.name !== name || pkg.version !== version || build.channel !== "release" || !/^[0-9a-f]{40}$/.test(build.commit))
    throw Error("安装包的包名、版本、通道或提交号无效");
  return { build, read };
}

export async function latestRelease(repo: string, name: string) {
  const url = new URL(`/repos/${repo}/releases/latest`, process.env.BRIDGE_RELEASE_API ?? "https://api.github.com");
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw Error("无法读取最新正式 Release：HTTP " + res.status);
  const data = await res.json() as { tag_name: string; draft?: boolean; prerelease?: boolean; assets: {name: string; browser_download_url: string}[] };
  const version = data.tag_name?.slice(1);
  if (data.draft || data.prerelease || !data.tag_name?.startsWith("v") || !semver.test(version)) throw Error("正式 Release 标签无效");
  const filename = assetName(name, version);
  const matches = data.assets.filter(a => a.name === filename);
  if (matches.length !== 1) throw Error("Release 必须包含唯一的 " + filename);
  return { version, filename, url: matches[0].browser_download_url };
}
