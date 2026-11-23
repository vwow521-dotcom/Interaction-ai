// Record which commit this build came from, so `ai-bridge doctor` can say whether the install is current.
// Runs from `prepare` (after `npm run build`), which npm also runs when installing from GitHub
// (`npm install -g github:<owner>/<repo>`): npm clones the repo, installs devDependencies and runs prepare there.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const channel = process.env.BRIDGE_BUILD_CHANNEL ?? "dev";
if (!["main", "dev", "release"].includes(channel)) throw Error("未知构建通道：" + channel);
const info = {
  channel,
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain", "--untracked-files=no") ? true : false,
  builtAt: new Date().toISOString(),
};
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/build-info.json", JSON.stringify(info, null, 2) + "\n");
console.log(`build-info: ${info.commit?.slice(0, 7) ?? "（不是 git 检出）"}${info.dirty ? "（有未提交改动）" : ""}`);
