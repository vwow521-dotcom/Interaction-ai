// Thin wrapper over the git CLI in the target project.
import { execFile, execFileSync } from "node:child_process";

const MAX_BUFFER = 32 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<{ ok: boolean; code: number | string | undefined; out: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER, windowsHide: true, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) =>
      // trimEnd only: `git status --porcelain` lines start with a significant space.
      resolve({ ok: !err, code: err?.code, out: (err ? [stderr, stdout].filter(Boolean).join("\n") || err.message : stdout).toString().trimEnd() }),
    );
  });
}

export async function isRepo(cwd: string) {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

export async function dirtyFiles(cwd: string): Promise<string[]> {
  // Panel refreshes must not acquire the index lock while a handoff stages or commits changes.
  const r = await git(cwd, ["--no-optional-locks", "status", "--porcelain"]);
  return r.ok && r.out ? r.out.split("\n") : [];
}

// Scope the old and new paths of a rename independently. NULs preserve literal filenames.
const changedFileArgs = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "-uall"];
const parseChangedFiles = (out: string) => out.split("\0").filter(Boolean).map((entry) => entry.slice(3));

/** Paths (forward slashes, relative to the repo root) with uncommitted changes, including untracked files. */
export async function changedFiles(cwd: string) {
  const r = await git(cwd, changedFileArgs);
  if (r.ok) return { paths: parseChangedFiles(r.out) };
  if (r.out.startsWith("fatal: not a git repository")) return { paths: [] };
  return { paths: [], error: "git status 失败：" + r.out };
}

/** Capture the task's baseline before publishing a new assignment. */
export function snapshotChangedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["-C", cwd, ...changedFileArgs], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return parseChangedFiles(out);
  } catch {
    return [];
  }
}

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globMatch(glob: string, file: string): boolean {
  const re = glob
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*|\?/g, (wildcard) => {
      switch (wildcard) {
        case "**/": return "(?:[^/]+/)*";
        case "**": return ".*";
        case "*": return "[^/]*";
        default: return "[^/]";
      }
    });
  return new RegExp(`^${re}$`, "i").test(file);
}

/** Normalise a lease glob: forward slashes, no leading ./, a trailing / means the whole directory. */
export function normGlob(g: string) {
  let x = g.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (x.endsWith("/")) x += "**";
  return x;
}

/** Could some file match both globs? Exact for literal paths; conservative (prefix check) when both have wildcards. */
export function globsOverlap(a: string, b: string): boolean {
  const A = normGlob(a), B = normGlob(b);
  if (globMatch(A, B) || globMatch(B, A)) return true;
  const lit = (g: string) => g.split(/[*?]/)[0].toLowerCase();
  const wa = /[*?]/.test(A), wb = /[*?]/.test(B);
  if (!wa || !wb) return false;
  const pa = lit(A), pb = lit(B);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export type CommitResult = { sha: string } | { error: string } | { skipped: string };

/** Stage everything and commit. No changes → skipped, unless allowEmpty (review conclusions). */
export async function commitAll(cwd: string, subject: string, body: string, opts: { allowEmpty?: boolean } = {}): Promise<CommitResult> {
  if (!(await isRepo(cwd))) return { skipped: "不是 git 仓库" };
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return { error: "git add 失败：" + add.out };
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (!staged.ok && staged.code !== 1) return { error: "git diff 失败：" + staged.out };
  if (staged.ok && !opts.allowEmpty) return { skipped: "没有文件改动" };
  const c = await git(cwd, ["commit", ...(staged.ok ? ["--allow-empty"] : []), "-m", subject, "-m", body]);
  if (!c.ok) return { error: "git commit 失败：" + c.out };
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return sha.ok ? { sha: sha.out } : { error: sha.out };
}

/** Commit only `paths` (staging their additions and deletions), leaving everything else in the index and
 *  work tree alone. No paths and allowEmpty → an empty commit that ignores whatever else is staged. */
export async function commitPaths(cwd: string, paths: string[], subject: string, body: string, opts: { allowEmpty?: boolean } = {}): Promise<CommitResult> {
  if (!(await isRepo(cwd))) return { skipped: "不是 git 仓库" };
  if (!paths.length) {
    if (!opts.allowEmpty) return { skipped: "本任务范围内没有文件改动" };
    const c = await git(cwd, ["commit", "--only", "--allow-empty", "-m", subject, "-m", body]);
    if (!c.ok) return { error: "git commit 失败：" + c.out };
  } else {
    const add = await git(cwd, ["add", "-A", "--", ...paths]);
    if (!add.ok) return { error: "git add 失败：" + add.out };
    if (!opts.allowEmpty) {
      const staged = await git(cwd, ["diff", "--cached", "--quiet", "--", ...paths]);
      if (staged.ok) return { skipped: "本任务范围内没有文件改动" };
      if (staged.code !== 1) return { error: "git diff 失败：" + staged.out };
    }
    const c = await git(cwd, ["commit", "--only", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-m", subject, "-m", body, "--", ...paths]);
    if (!c.ok) return { error: "git commit 失败：" + c.out };
  }
  const sha = await git(cwd, ["rev-parse", "HEAD"]);
  return sha.ok ? { sha: sha.out } : { error: sha.out };
}

export async function show(cwd: string, sha: string) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return "无效的提交号";
  const r = await git(cwd, ["show", "--stat", "--patch", "--format=fuller", sha]);
  return r.out;
}
