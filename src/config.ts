// Loads <project>/bridge.config.yaml (see bridge.config.example.yaml). Missing file → built-in default pipeline.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { DOORBELL_KINDS } from "./doorbells/types.js";

const StageSchema = z.object({
  id: z.string().regex(/^[\w-]+$/, "stage id 只能包含字母、数字、_ 和 -"),
  role: z.string(),
  agent: z.string(),
  gate: z.boolean().default(false),
  on_reject: z.string().optional(),
  instructions: z.string().optional(),
  // Files this stage is responsible for (globs, relative to the project). Advisory: another stage
  // touching them is flagged on the approval card, not blocked.
  owns: z.array(z.string()).optional(),
});

const AcpSchema = z.object({
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcp: z.enum(["stdio", "http"]).optional(),
  mode: z.string().trim().min(1).optional(),
  permissions: z.enum(["allow", "deny"]).default("deny"),
});

export const DEFAULT_REVIEW_INSTRUCTIONS = "首次审查要一次列全：先跑完验收标准和相关回归再下结论。每个阻塞问题写进 issues，能复现的附 repro（command、expect，需要时写 cwd），复现用的脚本放在 shared_dir。复审时先对 feedback.blocking 逐条写 rechecks，再提新问题，新问题要写 late_reason。不影响通过的建议写进 observations。";

const DEFAULT_TASK_TEMPLATE = [
  {
    id: "implement",
    role: "实现",
    agent: "owner",
    gate: false,
    instructions: "按任务描述和会议纪要实现，只改本任务 paths 范围内的文件，并自己验证一遍。",
  },
  {
    id: "review",
    role: "审查",
    agent: "reviewer",
    gate: true,
    on_reject: "implement",
    instructions: DEFAULT_REVIEW_INSTRUCTIONS,
  },
];

const ConfigSchema = z
  .object({
    project: z.string().optional(),
    agents: z.record(
      z.string(),
      z
        .object({
          product: z.string().optional(),
          notes: z.string().trim().refine((notes) => [...notes].length <= 200, "notes 最多 200 字").optional(),
          // How the postman wakes this agent: an ordered list tried in turn (poll always last), a single
          // kind, or auto = the product's default chain (src/products/); for an
          // unknown product, whatever the client registers.
          doorbell: z.union([z.literal("auto"), z.enum(DOORBELL_KINDS), z.array(z.enum(DOORBELL_KINDS)).min(1)]).default("auto"),
          acp: AcpSchema.optional(),
        })
        .default({ doorbell: "auto" }),
    ),
    pipeline: z.array(StageSchema).min(1),
    // Stages every meeting-planned task runs. agent: "owner" / "reviewer" (from the task) or a fixed agent id.
    // Stages whose agent is "reviewer" are skipped for tasks without a reviewer.
    task_template: z.array(StageSchema).min(1).default(DEFAULT_TASK_TEMPLATE),
    meetings: z
      .object({
        dir: z.string().default("doc/meetings"), // where minutes are written (relative to the project)
        facilitator: z.string().optional(), // writes the final plan; default: first agent
      })
      .default({ dir: "doc/meetings" }),
    leases: z
      .object({ default_ttl_seconds: z.number().positive().default(3600) }) // reserve_paths without ttl
      .default({ default_ttl_seconds: 3600 }),
    wait: z
      .object({
        poll_seconds: z.number().positive().default(50),
        stale_after_seconds: z.number().positive().default(90),
        offline_after_seconds: z.number().positive().default(300),
      })
      .default({ poll_seconds: 50, stale_after_seconds: 90, offline_after_seconds: 300 }),
    doorbells: z
      .object({
        max_unconfirmed_rings: z.number().int().positive().default(3),
        cooldown_seconds: z.number().positive().max(2_147_483).default(600),
      })
      .default({ max_unconfirmed_rings: 3, cooldown_seconds: 600 }),
    mail: z
      .object({
        ring_retry_seconds: z.number().positive().default(120), // rung but not fetched → ring again
        max_rings: z.number().int().positive().default(3), // then ask the human to wake the agent
        ack_timeout_seconds: z.number().positive().default(600), // fetched ack_required mail not acked → flag
      })
      .default({ ring_retry_seconds: 120, max_rings: 3, ack_timeout_seconds: 600 }),
    chat: z
      .object({
        history: z.number().int().min(0).max(50).default(10), // earlier messages sent along with a chat mail
        // Agent messages in a row (no human message in between) after which agents' @mentions stop waking anyone.
        max_agent_turns: z.number().int().positive().default(6),
      })
      .default({ history: 10, max_agent_turns: 6 }),
    notify: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    git: z
      .object({
        auto_commit: z.boolean().default(true),
        // A handoff that changed nothing but carries a review verdict still gets an (empty) commit,
        // so review conclusions show up in `git log`.
        commit_reviews: z.boolean().default(true),
      })
      .default({ auto_commit: true, commit_reviews: true }),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const s of c.pipeline) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `stage id 重复：${s.id}` });
      ids.add(s.id);
      if (!(s.agent in c.agents)) ctx.addIssue({ code: "custom", message: `stage ${s.id} 的 agent「${s.agent}」不在 agents 里` });
    }
    for (const s of c.pipeline)
      if (s.on_reject && !ids.has(s.on_reject)) ctx.addIssue({ code: "custom", message: `stage ${s.id} 的 on_reject「${s.on_reject}」不存在` });
    const tids = new Set<string>();
    for (const s of c.task_template) {
      if (tids.has(s.id)) ctx.addIssue({ code: "custom", message: `task_template 的 stage id 重复：${s.id}` });
      tids.add(s.id);
      if (!["owner", "reviewer"].includes(s.agent) && !(s.agent in c.agents))
        ctx.addIssue({ code: "custom", message: `task_template 的 stage ${s.id} 的 agent「${s.agent}」应为 owner、reviewer 或 agents 里的身份` });
    }
    for (const s of c.task_template)
      if (s.on_reject && !tids.has(s.on_reject)) ctx.addIssue({ code: "custom", message: `task_template 的 stage ${s.id} 的 on_reject「${s.on_reject}」不存在` });
    if (c.meetings.facilitator && !(c.meetings.facilitator in c.agents))
      ctx.addIssue({ code: "custom", message: `meetings.facilitator「${c.meetings.facilitator}」不在 agents 里` });
  });

export type Stage = z.infer<typeof StageSchema>;
export type AcpConfig = z.infer<typeof AcpSchema>;
export type Config = z.infer<typeof ConfigSchema> & { projectDir: string; source: string };

export const DEFAULT_CONFIG_YAML = `agents:
  claude: { product: claude-code, doorbell: auto }
  codex:  { product: codex, doorbell: auto }
  # notes 可选，最多 200 字。供会议分配任务时参考，在办公室的成员详情里也可查看。
  # 后台成员按需启用：
  # antigravity:
  #   product: antigravity
  #   doorbell: auto
  #   notes: "适合文档、摘要和文字类第二意见"
  #   acp: { mcp: stdio, mode: accept-edits, permissions: deny }
  # deepseek:
  #   product: deepseek-harness
  #   doorbell: auto
  #   acp:
  #     command: '%DSH_INSTALL_DIR%\\DeepSeek Harness.exe'
  #     args: [--expose-internals, '%DSH_INSTALL_DIR%\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js', --profile, acp]
  #     env: { ELECTRON_RUN_AS_NODE: '1' }
  #     mcp: http
  #     permissions: deny
pipeline:
  - id: plan
    role: 规划/架构
    agent: claude
    gate: true
    instructions: 把目标细化成可执行的设计说明和验收标准，写进项目文件，交接单里列出关键决策。
    owns: [PLAN.md, "docs/**", "doc/**"]
  - id: implement
    role: 编码
    agent: codex
    instructions: 按规划阶段的设计说明实现，并自己跑一遍验收标准。
  - id: review
    role: 审查
    agent: claude
    gate: true
    on_reject: implement
    instructions: ${DEFAULT_REVIEW_INSTRUCTIONS}
task_template:
  - id: implement
    role: 实现
    agent: owner
    instructions: 按任务描述和会议纪要实现，只改本任务 paths 范围内的文件，并自己验证一遍。
  - id: review
    role: 审查
    agent: reviewer
    gate: true
    on_reject: implement
    instructions: ${DEFAULT_REVIEW_INSTRUCTIONS}
meetings:
  dir: doc/meetings
doorbells:
  max_unconfirmed_rings: 3
  cooldown_seconds: 600
`;

export function loadConfig(projectDir: string): Config {
  const file = path.join(projectDir, "bridge.config.yaml");
  const exists = fs.existsSync(file);
  const raw = YAML.parse(exists ? fs.readFileSync(file, "utf8") : DEFAULT_CONFIG_YAML);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`配置文件无效：${exists ? file : "(内置默认配置)"}\n${msgs}`);
  }
  return { ...parsed.data, projectDir, source: exists ? file : "(内置默认配置)" };
}
