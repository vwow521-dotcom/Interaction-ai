import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function smokeRelease(root: string, daemonBase?: string) {
  if (daemonBase) await checkDaemon(daemonBase);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-release-smoke-"));
  const repo = path.join(tmp, "repo");
  const pack = path.join(tmp, "package");
  const log = path.join(tmp, "commands");
  const preload = path.join(tmp, "fake-npm.cjs");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const filename = "ai-bridge-" + version + ".tgz";
  const asset = path.join(tmp, filename);
  const entry = { name: filename, browser_download_url: "" };
  let assets = [entry], metadataStatus = 200, downloadStatus = 200;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/releases/latest")) {
      res.writeHead(metadataStatus);
      res.end(JSON.stringify({ tag_name: "v" + version, assets }));
    } else if (req.url === "/asset") {
      res.writeHead(downloadStatus);
      res.end(fs.readFileSync(asset));
    } else if (req.url === "/api/state") res.end(JSON.stringify({ project: repo, daemon: { version: "0.12.0", commit: "old", project: repo, port: 1234 } }));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as {port: number}).port;
  entry.browser_download_url = base + "/asset";
  const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
  try {
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q");
    git("config", "user.name", "release smoke");
    git("config", "user.email", "release@example.invalid");
    write(path.join(repo, "package.json"), { name: "ai-bridge", version, files: ["CHANGELOG.md"] });
    write(path.join(repo, "package-lock.json"), { version, packages: { "": { version } } });
    fs.writeFileSync(path.join(repo, "CHANGELOG.md"), "## [" + version + "]\n\nRelease notes\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
    const dry = () => exec(process.execPath, [path.join(root, "scripts/release.mjs"), "--dry-run"], { cwd: repo });
    assert.match((await dry()).stdout, /gh release create v/);
    fs.writeFileSync(path.join(repo, "untracked"), "dirty");
    await assert.rejects(dry, /工作区不干净/);
    fs.unlinkSync(path.join(repo, "untracked"));
    fs.writeFileSync(path.join(repo, "CHANGELOG.md"), "## 0.0.1\nold\n");
    await assert.rejects(dry, /CHANGELOG/);
    fs.writeFileSync(preload, `
const cp = require('node:child_process'), fs = require('node:fs');
cp.execSync = cmd => {
  if (cmd === 'npm root -g') return process.env.FAKE_GLOBAL;
  fs.appendFileSync(process.env.FAKE_LOG, cmd + '\\n');
  if (!['npm install -g ./candidate.tgz','ai-bridge setup --refresh','ai-bridge doctor'].includes(cmd))
    throw Error('unexpected command: ' + cmd);
};
require('node:module').syncBuiltinESMExports();`);
    const env = { ...process.env, BRIDGE_URL: base, BRIDGE_RELEASE_API: base, HOME: tmp, USERPROFILE: tmp,
      CODEX_HOME: path.join(tmp, ".codex"), FAKE_GLOBAL: path.join(tmp, "global"), FAKE_LOG: log };
    const cli = (...args: string[]) => exec(process.execPath, ["--import", "tsx", "--require", preload, "src/cli.ts", ...args], { cwd: root, env });
    const build = { channel: "release", commit: "a".repeat(40) };
    const archive = (pkg: object, info: object) => {
      fs.mkdirSync(path.join(pack, "dist"), { recursive: true });
      write(path.join(pack, "package.json"), pkg);
      write(path.join(pack, "dist/build-info.json"), info);
      execFileSync("tar", ["-czf", filename, "package"], { cwd: tmp });
    };
    const pkg = { name: "ai-bridge", version };
    archive(pkg, build);
    const rejected = async () => {
      await assert.rejects(() => cli("update"));
      assert.equal(fs.existsSync(log), false);
    };
    metadataStatus = 404; await rejected(); metadataStatus = 200;
    assets = []; await rejected();
    assets = [entry, entry]; await rejected(); assets = [entry];
    downloadStatus = 404; await rejected(); downloadStatus = 200;
    for (const [manifest, info] of [[{ ...pkg, name: "other" }, build], [{ ...pkg, version: "0.1.0" }, build],
      [pkg, { ...build, channel: "main" }], [pkg, { ...build, commit: "" }]]) {
      archive(manifest, info);
      await rejected();
    }
    fs.rmSync(path.join(pack, "dist/build-info.json"));
    execFileSync("tar", ["-czf", filename, "package"], { cwd: tmp });
    await rejected();
    archive(pkg, build);
    await cli("update");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["npm install -g ./candidate.tgz", "ai-bridge setup --refresh", "ai-bridge doctor"]);
    const globalDir = path.join(env.FAKE_GLOBAL, "ai-bridge");
    fs.mkdirSync(path.join(globalDir, "dist"), { recursive: true });
    write(path.join(globalDir, "package.json"), pkg);
    write(path.join(globalDir, "dist/build-info.json"), build);
    fs.unlinkSync(log);
    assert.match((await cli("update")).stdout, /已安装最新正式 Release/);
    await assert.rejects(() => cli("update", "--channel", "nightly"));
    await assert.rejects(() => cli("update", "--channel", "release", "--ref", "main"));
    assert.match((await cli("update", "--dry-run", "--ref", "topic")).stdout, /检出并构建 topic/);
    assert.equal(fs.existsSync(log), false);
    assert.match((await cli("doctor", "--project", repo)).stdout, /停掉 ai-bridge 后重新 ai-bridge start/);
    console.log("✓ Release dry-run、离线更新校验、安装调用顺序与运行版本差异");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function checkDaemon(base: string) {
  const { daemon } = await (await fetch(base + "/api/state")).json() as any;
  assert.deepEqual(Object.keys(daemon).sort(), ["version","commit","dirty","channel","built_at","started_at","project","port","install_dir"].sort());
  assert.equal(daemon.commit, "dev");
  assert.equal(daemon.channel, "dev");
  assert.equal(daemon.built_at, null);
  assert.equal(daemon.dirty, null);
  assert.equal(daemon.port, Number(new URL(base).port));
  assert.ok(path.isAbsolute(daemon.project) && path.isAbsolute(daemon.install_dir));
  assert.equal(new Date(daemon.started_at).toISOString(), daemon.started_at);
  assert.equal(daemon.version, JSON.parse(fs.readFileSync(path.join(daemon.install_dir, "package.json"), "utf8")).version);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await smokeRelease(process.cwd());
