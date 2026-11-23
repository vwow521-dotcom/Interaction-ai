import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { tsImport } from "tsx/esm/api";

const { assetName, semver, inspectAsset } = await tsImport("../src/release-asset.ts", import.meta.url);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));

function release() {
  if (process.argv.slice(2).some(arg => arg !== "--dry-run")) throw Error("只支持 --dry-run");
  const pkg = json("package.json");
  const { version } = pkg;
  const lock = json("package-lock.json");
  if (!semver.test(version) || version !== lock.version || version !== lock.packages?.[""]?.version)
    throw Error("版本号无效或与 package-lock.json 不一致");
  const sections = fs.readFileSync("CHANGELOG.md", "utf8").split(/(?=^##\s)/m);
  const section = sections.find(text => {
    const title = text.split(/\r?\n/, 1)[0].split(/\s+/)[1];
    return title === version || title === "[" + version + "]";
  });
  if (!section || !section.slice(section.indexOf("\n") + 1).trim() || !section.includes("\n")) throw Error("CHANGELOG 缺少本版本的非空小节");
  if (git("status", "--porcelain", "--untracked-files=all")) throw Error("工作区不干净");
  const tag = "v" + version;
  const pack = "release/" + assetName(pkg.name, version);
  const notes = "release/notes-" + version + ".md";
  const command = `gh release create ${tag} ${pack} --title "ai-bridge ${version}" --notes-file ${notes}`;
  if (process.argv.includes("--dry-run")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-bridge-pack-"));
    try {
      for (const entry of ["package.json", ...(pkg.files ?? [])]) {
        if (fs.existsSync(entry)) fs.cpSync(entry, path.join(tmp, entry), { recursive: true });
      }
      execSync("npm pack --dry-run --json --ignore-scripts", { cwd: tmp, stdio: "inherit" });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    console.log("将检查 tag，运行 typecheck、build、smoke，打包验包并写入发布说明。");
  } else {
    if (git("tag", "--list", tag)) throw Error("本地 tag 已存在：" + tag);
    let remote;
    try { remote = git("ls-remote", "--tags", "origin", "refs/tags/" + tag); }
    catch { console.warn("无法检查远端 tag"); }
    if (remote) throw Error("远端 tag 已存在：" + tag);
    const head = git("rev-parse", "HEAD");
    for (const step of ["typecheck", "build", "smoke"]) execSync("npm run " + step, { stdio: "inherit" });
    fs.mkdirSync("release", { recursive: true });
    execSync("npm pack --pack-destination release", { stdio: "inherit", env: { ...process.env, BRIDGE_BUILD_CHANNEL: "release" } });
    const { build, read } = inspectAsset(pack, pkg.name, version);
    if (build.commit !== head || build.dirty !== false) throw Error("安装包提交或工作区状态不符");
    const entries = new Set(execFileSync("tar", ["-tzf", pack], { encoding: "utf8" }).trim().split(/\r?\n/));
    const required = ["dist/cli.js", "dist/daemon.js", "bin/ai-bridge.mjs", "CHANGELOG.md", "README.md", "README.en.md"];
    for (const file of ["README.md", "README.en.md"])
      for (const match of read(file).matchAll(/docs\/images\/[^\s)"'<>]+/g)) required.push(match[0]);
    for (const entry of required) if (!entries.has("package/" + entry)) throw Error("安装包缺少 " + entry);
    fs.writeFileSync(notes, section.trim() + "\n");
  }
  console.log(command);
}
try { release(); } catch (error) { console.error(error.message); process.exitCode = 1; }
