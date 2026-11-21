// MCP tool surface. One McpServer per client session; all share the Engine.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import { z } from "zod";
import type { Engine } from "./engine.js";
import type { Result } from "./engine/context.js";
import { productByClient, productById } from "./products/index.js";
import type { BridgeClient } from "./products/types.js";

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
const version: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const prompt = (message: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: message } }] });

export function buildServer(engine: Engine, client: BridgeClient, acpAgent?: string): McpServer {
  const server = new McpServer({ name: "ai-bridge", version });
  const ids = engine.presence.agentIds().join(", ");
  const agentId = z.string().describe(`你的身份，可选：${ids}`);
  server.registerPrompt("join", {
    title: "加入协作桥",
    description: "获取工作协议并查收协作桥的信件。",
    argsSchema: { agent_id: agentId.optional() },
  }, ({ agent_id }) => prompt(
    (agent_id === undefined
      ? "调用 bridge 的 join，不填 agent_id。若无法确定身份，按返回的候选问用户。"
      : `你是 AI 协作桥中的 ${agent_id}。调用 bridge 的 join（agent_id = ${JSON.stringify(agent_id)}）。`) +
    "然后严格按返回的 protocol 工作。交接单和进度汇报用中文。",
  ));
  server.registerPrompt("inbox", { title: "查收协作桥信件", description: "继续处理寄给当前成员的信件。" }, () => prompt(
    "调用 bridge 的 fetch_inbox，填写加入时返回的 agent_id，按取信结果继续工作。尚未加入时先调用 join，不填 agent_id，按返回的 protocol 工作。",
  ));
  const withAgent = async (agent: string, session: string | undefined, run: () => Result | Promise<Result>) => {
    if (acpAgent && acpAgent !== agent) return text({ error: `此后台会话只服务于 ${acpAgent}。` });
    if (acpAgent && (engine.presence.acpAgent(session) !== acpAgent || !engine.doorbells.acp.connecting(acpAgent)))
      return text({ error: "后台会话已停止。" });
    const recovered = engine.presence.recoverBinding(agent, session);
    const result = await run();
    if (!recovered) return text(result);
    const doorbell = engine.presence.doorbellKind(agent);
    return text({
      ...result,
      identity_recovered: true,
      doorbell,
      identity_note:
        `旧 MCP 会话已关闭，已在本会话恢复 ${agent} 身份。` +
        (doorbell === "poll" ? "门铃是轮询：处理完后调用 wait_for_mail 等信。" : "门铃已重新接上，不需要轮询：处理完后直接结束本回合，有新信时会叫醒你。"),
    });
  };

  server.registerTool(
    "join",
    {
      title: "加入协作桥",
      description: "声明你在协作桥中的身份，获取你负责的阶段和工作协议。会话开始时调用一次。",
      inputSchema: {
        agent_id: agentId.optional(),
        takeover: z.boolean().optional().describe("该身份已被另一个会话占用、且你确定自己就是它时，设为 true 接管"),
        _doorbell: z.string().optional().describe("由协作桥的本地转接程序自动填写，不要手动设置"),
        _recovery: z.object({ key: z.uuid(), replay: z.boolean() }).optional().describe("由本地转接程序自动管理，不要手动设置"),
      },
    },
    async ({ agent_id, takeover, _doorbell, _recovery }, extra) => {
      if (acpAgent && agent_id && agent_id !== acpAgent) return text({ error: `此后台会话只服务于 ${acpAgent}。` });
      agent_id ??= acpAgent;
      if (agent_id === undefined) {
        const product = productByClient(client);
        const matches = product ? engine.presence.agentIds().filter((id) => productById(engine.cfg.agents[id].product) === product) : [];
        if (matches.length !== 1) {
          const candidates = matches.length ? matches : engine.presence.agentIds();
          const reason = matches.length ? "有多个成员与客户端产品匹配" : "没有成员与客户端产品匹配";
          return text({ error: `${reason}，请指定 agent_id。可选：${candidates.join("、")}`, candidates });
        }
        agent_id = matches[0];
      }
      return text(engine.presence.join(agent_id, extra.sessionId, takeover, _doorbell, _recovery, client));
    },
  );

  server.registerTool(
    "fetch_inbox",
    {
      title: "取信",
      description: "取走你所有未读的信（任务、会议发言邀请、聊天消息、问题答复、其他成员的来信）。被「[协作桥]」消息叫醒后调用。",
      inputSchema: { agent_id: agentId },
    },
    async ({ agent_id }, extra) => withAgent(agent_id, extra.sessionId, () => engine.postman.fetchInbox(agent_id, extra.sessionId)),
  );

  server.registerTool(
    "ack",
    {
      title: "确认信件",
      description: "处理完 ack_required 的信后调用，告诉用户你已经收到并处理。task 信不用手动确认，submit_handoff 会自动确认。",
      inputSchema: { agent_id: agentId, mail_ids: z.array(z.string()).min(1) },
    },
    async ({ agent_id, mail_ids }, extra) => withAgent(agent_id, extra.sessionId, () => engine.postman.ack(agent_id, extra.sessionId, mail_ids)),
  );

  server.registerTool(
    "wait_for_mail",
    {
      title: "等信（无门铃时使用）",
      description: `仅在 join 返回 doorbell 为 poll 时使用：阻塞最长约 ${engine.cfg.wait.poll_seconds} 秒等新信。有信时直接返回信件；返回 keep_waiting 时必须立即再次调用。`,
      inputSchema: { agent_id: agentId },
    },
    async ({ agent_id }, extra) => {
      const token = extra._meta?.progressToken;
      const onTick =
        token !== undefined
          ? (n: number) =>
              extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: "等信中…" } }).catch(() => {})
          : undefined;
      return withAgent(agent_id, extra.sessionId, () => engine.postman.waitForMail(agent_id, extra.sessionId, extra.signal, onTick));
    },
  );

  server.registerTool(
    "send_mail",
    {
      title: "给其他成员写信",
      description: "给协作桥里的其他成员写信（提问、提醒、协调）。对方会被门铃叫醒。",
      inputSchema: {
        agent_id: agentId,
        to: z.string().describe(`收件人，可选：${ids}`),
        subject: z.string().describe("一句话主题"),
        body: z.string(),
        ack_required: z.boolean().optional().describe("需要对方确认时设为 true"),
        mail_id: z.string().optional().describe("可选：自定义信件 id，重发同一 id 不会重复投递"),
      },
    },
    async ({ agent_id, to, subject, body, ack_required, mail_id }, extra) =>
      withAgent(agent_id, extra.sessionId, () => engine.postman.sendFromAgent(agent_id, extra.sessionId, to, subject, body, mail_id, ack_required)),
  );

  server.registerTool(
    "say",
    {
      title: "在聊天里发言",
      description:
        "在项目聊天室里说一句话，用户在面板上能看到。回答 chat 信时带上 reply_to。" +
        "会被叫醒的人：mentions（或正文里的 @名字）点到的成员，加上 reply_to 那条消息的作者（如果是成员）。回复用户、又没有 @ 任何成员时，只给用户看。" +
        "wake=false 时谁都不叫醒，适合收住话题（如「就聊到这儿」）。成员之间连续聊 " +
        engine.cfg.chat.max_agent_turns +
        " 条、用户都没插话时，桥会停止叫醒，等用户说话。交付工作用 submit_handoff，正式协调用 send_mail，聊天只用来简短交流。",
      inputSchema: {
        agent_id: agentId,
        text: z.string().describe("要说的话，简短"),
        mentions: z.array(z.string()).optional().describe(`要叫醒的成员，可选：${ids}，或 all`),
        reply_to: z.number().int().optional().describe("回复哪条聊天消息（chat 信里的 message_id）"),
        wake: z.boolean().optional().describe("默认 true；false 时只记在聊天里，不叫醒任何人"),
      },
    },
    async ({ agent_id, text: t, mentions, reply_to, wake }, extra) =>
      withAgent(agent_id, extra.sessionId, () => engine.chat.say(agent_id, extra.sessionId, t, mentions ?? [], reply_to, wake ?? true)),
  );

  server.registerTool(
    "get_context",
    {
      title: "获取任务上下文",
      description: "获取当前任务的目标、你手上的任务、本轮反馈、各任务和阶段状态、最近几份交接单（更早的只给一句摘要）、文件租约、会议纪要位置和共享笔记。需要比任务信更多的背景时调用。",
      inputSchema: { agent_id: agentId, last_n: z.number().int().min(0).max(50).optional().describe("返回最近几份完整交接单，默认 3") },
    },
    async ({ agent_id, last_n }, extra) => withAgent(agent_id, extra.sessionId, () => engine.workspace.getContext(agent_id, extra.sessionId, last_n ?? 3)),
  );

  server.registerTool(
    "leave",
    {
      title: "退出协作桥",
      description: "释放你的身份（例如换到新会话之前），让新会话可以直接 join。",
      inputSchema: { agent_id: agentId },
    },
    async ({ agent_id }, extra) => text(engine.presence.release(agent_id, "agent", extra.sessionId)),
  );

  server.registerTool(
    "report_progress",
    {
      title: "汇报进度",
      description: "工作中途汇报一句进度，用户会在面板上实时看到。不会改变阶段状态。",
      inputSchema: { agent_id: agentId, text: z.string().describe("一句话进度") },
    },
    async ({ agent_id, text: t }, extra) => withAgent(agent_id, extra.sessionId, () => engine.workspace.reportProgress(agent_id, extra.sessionId, t)),
  );

  server.registerTool(
    "post_note",
    {
      title: "记录共享笔记",
      description: "记录值得所有成员共享的约定、决策或坑（跨任务保留），替代散落的 md 交接文件。",
      inputSchema: { agent_id: agentId, topic: z.string().describe("主题，如 架构、约定、坑"), text: z.string() },
    },
    async ({ agent_id, topic, text: t }, extra) => withAgent(agent_id, extra.sessionId, () => engine.workspace.postNote(agent_id, extra.sessionId, topic, t)),
  );

  server.registerTool(
    "read_notes",
    {
      title: "读取共享笔记",
      description: "读取共享笔记，可按主题过滤。",
      inputSchema: { agent_id: agentId, topic: z.string().optional() },
    },
    async ({ agent_id, topic }, extra) => withAgent(agent_id, extra.sessionId, () => engine.workspace.readNotes(agent_id, extra.sessionId, topic)),
  );

  server.registerTool(
    "ask_human",
    {
      title: "向用户提问",
      description: "遇到必须由用户决定的问题时调用。问题会出现在用户的面板上并通知用户；立即返回，用户的答复之后以信件送达。",
      inputSchema: { agent_id: agentId, question: z.string() },
    },
    async ({ agent_id, question }, extra) => withAgent(agent_id, extra.sessionId, () => engine.workspace.askHuman(agent_id, extra.sessionId, question)),
  );

  server.registerTool(
    "submit_handoff",
    {
      title: "提交交接单",
      description: "完成本阶段后调用，提交结构化交接单。桥会自动 git 提交（有并行任务时只提交本任务范围内和你声明的文件）、确认任务信并推进流程。",
      inputSchema: {
        agent_id: agentId,
        summary: z.string().describe("一句话：本阶段做了什么"),
        done: z.array(z.string()).default([]).describe("已完成事项"),
        todo: z.array(z.string()).default([]).describe("留给后续阶段的事项"),
        decisions: z
          .array(z.object({ what: z.string(), why: z.string() }))
          .default([])
          .describe("关键决策及理由"),
        files_changed: z.array(z.string()).default([]).describe("改动的文件路径"),
        notes_for_next: z.string().default("").describe("给下一个角色的注意事项"),
        verdict: z.enum(["approve", "reject"]).optional().describe("仅审查阶段：approve 通过 / reject 打回"),
        review_comments: z.array(z.string()).optional().describe("旧写法；建议改用 issues"),
        issues: z.array(z.strictObject({
          problem: z.string(),
          repro: z.object({ command: z.string(), cwd: z.string().optional(), expect: z.string() }).optional(),
          late_reason: z.string().optional(),
        })).optional().describe("仅审查阶段：本轮新增的阻塞问题。编号由桥分配；复审新增时说明上轮没发现的原因"),
        rechecks: z.array(z.object({
          id: z.string(),
          status: z.enum(["fixed", "not_fixed"]),
          note: z.string().optional(),
        })).optional().describe("复审时按编号逐条核对 feedback.blocking 中仍开放的问题"),
        addressed: z.array(z.object({
          id: z.string(),
          how: z.string(),
          verified: z.string().optional(),
        })).optional().describe("返工时按编号说明怎么改、验证命令和结果"),
        observations: z.array(z.string()).optional().describe("仅审查阶段：不影响通过的建议（非阻塞）"),
        task_id: z.string().optional().describe("可选：任务编号（如 T2）。你同时有多个进行中的任务时用来指明提交哪一个"),
      },
    },
    async ({ agent_id, task_id, ...data }, extra) => withAgent(agent_id, extra.sessionId, () => engine.scheduler.submitHandoff(agent_id, extra.sessionId, data, task_id)),
  );

  const planned = z.object({
    id: z.string().describe("任务编号，如 T1"),
    title: z.string(),
    description: z.string().default("").describe("要做什么、验收标准"),
    owner: z.string().describe(`负责人，可选：${ids}`),
    reviewer: z.string().nullable().optional().describe("审查人（可选，留空则不审查）"),
    depends_on: z.array(z.string()).default([]).describe("依赖的任务编号"),
    paths: z.array(z.string()).default([]).describe("预计改动的文件 glob，如 src/ui/**；并行任务之间不要重叠"),
  });

  server.registerTool(
    "submit_meeting_turn",
    {
      title: "会议发言",
      description: "在会议的当前一轮（提案 / 互评 / 定稿）提交你的发言。meeting 信里会说明本轮要写什么。定稿轮必须带 tasks。会自动确认这封会议信。",
      inputSchema: {
        agent_id: agentId,
        meeting_id: z.number().int(),
        content: z.string().describe("你的发言：方案、评价或最终方案（Markdown）"),
        decisions: z.array(z.object({ what: z.string(), why: z.string() })).optional().describe("定稿轮：关键决策及理由"),
        tasks: z.array(planned).optional().describe("提案轮可选（任务拆分草案）；定稿轮必填（最终任务清单）"),
      },
    },
    async ({ agent_id, meeting_id, content, decisions, tasks }, extra) =>
      withAgent(agent_id, extra.sessionId, () => engine.meetings.submitMeetingTurn(agent_id, extra.sessionId, meeting_id, content, tasks, decisions ?? [])),
  );

  server.registerTool(
    "reserve_paths",
    {
      title: "申请文件租约",
      description:
        "多个任务并行时，改动本任务范围以外的文件之前调用，申请这些文件的租约。和别人的租约冲突时不会授予，会返回占用者，并通知对方。再次调用同样的 glob 即续期。",
      inputSchema: {
        agent_id: agentId,
        globs: z.array(z.string()).min(1).describe("文件路径或 glob，如 src/api/** 、README.md；以 / 结尾表示整个目录"),
        exclusive: z.boolean().optional().describe("默认 true（独占）；只读或只追加时可设 false（共享）"),
        ttl_seconds: z.number().int().positive().max(86400).optional().describe(`租约时长，默认 ${engine.cfg.leases.default_ttl_seconds} 秒`),
        reason: z.string().optional().describe("一句话：为什么要改这些文件"),
      },
    },
    async ({ agent_id, globs, exclusive, ttl_seconds, reason }, extra) =>
      withAgent(agent_id, extra.sessionId, () => engine.leases.reservePaths(agent_id, extra.sessionId, globs, exclusive ?? true, ttl_seconds, reason ?? "")),
  );

  server.registerTool(
    "release_paths",
    {
      title: "释放文件租约",
      description: "提前释放你用 reserve_paths 申请的租约（不填 globs 则全部释放）。任务自带的租约在任务结束时自动释放。",
      inputSchema: { agent_id: agentId, globs: z.array(z.string()).optional() },
    },
    async ({ agent_id, globs }, extra) => withAgent(agent_id, extra.sessionId, () => engine.leases.releasePaths(agent_id, extra.sessionId, globs)),
  );

  return server;
}
