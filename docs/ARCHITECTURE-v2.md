# 架构 v2：邮递员（草案，待评审）

目标：把"每个 AI 每时每刻去信箱看有没有新东西"的长轮询，换成"有信放进信箱，邮递员按门铃通知一下"。同时把界面升级为圆桌会议 + 任务看板（见可点击原型）。

## 1. 借鉴清单

原则：不找一个完美的开源项目，而是从各有长处的项目里各挑出值得借鉴的设计。

| # | 来源 | 借鉴什么 | 在本项目里的落点 |
|---|---|---|---|
| 1 | open-agent-bridge | **事件触发**：消息先落库，再推送给收件方的适配器；收件方忙就排队，空闲（turn 结束）时再投递 | 邮递员的投递队列和"忙/闲"判断 |
| 2 | open-agent-bridge | **会话注入**：Claude Code 子进程继承 `CLAUDE_CODE_MESSAGING_SOCKET` + `TOKEN`，往这个套接字写一条 user 消息，就能唤醒正在运行的会话 | Claude 的门铃（第 4 节） |
| 3 | open-agent-bridge | **消息去重**：`message_id` 做主键，重发不会重复广播；适配器维护有上限的已投递 id 集合，重连时用回执账本重建 | 消息表主键 + 门铃侧去重 |
| 4 | open-agent-bridge | **回执分级**：`delivered_to_bridge` ≠ `displayed_to_client` ≠ 被模型读到 | 投递状态机分级，面板如实显示到了哪一级 |
| 5 | mcp_agent_mail | **可靠收发**：消息有 id、thread、发件人、收件人、重要程度；收件箱按"未读"拉取 | 信件模型和 `fetch_inbox` |
| 6 | mcp_agent_mail | **消息确认**：`ack_required` + `acknowledge`，超时未确认要升级提醒 | 任务分派、审批结果等关键信件必须确认，超时在面板标红 |
| 7 | mcp_agent_mail | **文件占用冲突管理**：按路径或 glob 申请租约（独占/共享，带 TTL），冲突时返回占用者；可选 pre-commit 守卫 | 看板并行任务的前提（第 6 节） |
| 8 | mcp_agent_mail | **人类监督者**：人发的信自动高优先级，并附"先停下处理"的说明 | 你在面板上的追问、打回、回答 |
| 9 | Agent Client Protocol | **分层**：MCP 负责工具（AI 调桥），ACP 负责 Agent 控制（桥启动、驱动、取消 AI 会话，统一处理权限请求） | 后台 worker（第 5 节） |
| 10 | Claude Code channels（官方，研究预览） | MCP 服务器用 `notifications/claude/channel` 往运行中的会话推事件 | Claude CLI 会话的备用门铃 |

后续看到好项目，继续往这张表里加。

## 2. 总体结构

```
          面板（圆桌 / 看板 / 审批）           Windows 通知
                 │                               ▲
                 ▼                               │
  ┌──────────────────── bridge 守护进程 ─────────┴────────┐
  │  会议引擎     任务引擎(DAG)     文件租约     git 提交     │
  │        │           │            │                        │
  │        └───── 产生事件 ────▶ 邮局（信件表 + 回执账本）   │
  │                                   │ 邮递员：按收件人选门铃 │
  └───────────────────────────────────┼──────────────────────┘
        MCP 工具（AI 主动调用）          │ 门铃（桥主动通知）
   join / fetch_inbox / ack / ...       ├─ Claude 桌面版：消息套接字注入
                                        ├─ Claude CLI：channels
                                        ├─ Codex 桌面版：长轮询兜底（见第 4 节）
                                        ├─ ACP worker：session/prompt
                                        └─ 剪贴板成员 / 你：Windows 通知 + 面板
```

两条通道分开：
- **MCP 是"取信和办事"**：AI 被唤醒后，自己调工具取信、确认、提交。
- **门铃只负责"叫醒"**：门铃消息只有一句话，比如"你有 1 封新信：T2 已分派给你，调用 fetch_inbox 查看"。不在门铃里塞正文，所以门铃丢了也不丢信。

## 3. 邮局

### 信件

`id`（主键，发件方生成，用来去重）、`thread`（任务 id 或会议 id）、`from`、`to[]`、`kind`、`subject`、`body`、`importance`（normal / high / human）、`ack_required`、`created_at`、`expires_at`。

信件种类：任务分派、审批结果、打回意见、会议邀请（提案 / 互评一轮）、你的追问、问题回答、文件冲突通知、系统消息。

### 回执账本（每个收件人每封信一行）

```
queued → rung（门铃已按） → fetched（AI 调 fetch_inbox 取走） → acked（AI 确认）
                 └─ 门铃失败 → 重试（最多 3 次，间隔 5 秒）→ 仍失败：标为"需要你去叫醒"
```

- 关键信件（分派、打回、你的追问）`ack_required = true`。超过 `ack_timeout`（默认 10 分钟）还没确认，面板标红，并发 Windows 通知给你。
- 门铃侧去重：每个门铃维护最近 5000 个已按过的 id。重连或重启时，从账本里把 fetched 和 acked 的信件 id 补回这个集合，避免把旧信再推一遍。

### 收件人忙闲

借鉴 open-agent-bridge：收件人正在干活时，门铃不打断，信先排队，等它空闲再按一次，多封信合并成一次。"空闲"的判断：它刚调用了 `submit_handoff` 或 `ack`，或超过 N 分钟没有任何工具调用。

## 4. 门铃（按产品）

| 产品 | 方式 | 依据 | 状态 |
|---|---|---|---|
| Claude 桌面版（Code 标签页） | 桥额外提供一个 **stdio 小程序**（`bridge-doorbell`），由 Claude 作为 MCP 服务器启动。它继承 `CLAUDE_CODE_MESSAGING_SOCKET` 和 `CLAUDE_CODE_MESSAGING_TOKEN`，连上守护进程等门铃；有信时往套接字写 `{"type":"auth"}` 和 `{"type":"user",...}` 两帧，会话就被唤醒 | 本机已确认：Claude 桌面版给子进程设置了这两个变量，套接字是 Windows 命名管道 `\\.\pipe\LOCAL\cc-msg-…`。帧格式来自 open-agent-bridge，它只在 Linux 上验证过 | **待实测（S1）** |
| Claude CLI | channels：`notifications/claude/channel` | 官方文档，研究预览，需要 `--channels` 或开发标志 | 备用 |
| Codex（ChatGPT 桌面版） | **Stop hook 门铃**：Codex 每次结束一轮都会运行 Stop hook。hook 进程向桥长轮询取信（等待期间模型不运行），有信就返回 `{"decision":"block","reason":"你有新信…"}`，Codex 会把 reason 当作新的用户消息继续干活。hook 超时前没有信就放行，之后由兜底接管 | Codex 官方 hooks 文档；S2 实测通过。外部无法直接连桌面版的 app-server（它用 stdio 私有启动），所以不走 app-server | **已验证（S2）** |
| ACP worker（Gemini CLI、codex-acp、claude-agent-acp） | 桥作为 ACP client 启动它们：`session/new` 把桥的 MCP 地址传过去，用 `session/prompt` 下发任务，用 `session/request_permission` 统一审批 | ACP 官方文档 | M3 |
| 剪贴板成员（Gemini、DeepSeek 桌面版） | Windows 通知你；面板一键复制提示词，你再把回答贴回来 | 不需要 AI 端支持 | M2 |
| 你 | Windows 通知（审批、提问、确认超时、失联）+ 面板 | — | M2 |

门铃按"能推就推，推不了就退回长轮询"降级。面板上每个成员旁边标出它当前用的是哪种门铃。

## 5. MCP 与 ACP 分工

- **MCP（工具层）**：所有 AI 都通过同一组工具和桥打交道，包括 `fetch_inbox`、`ack`、`send`、`reserve_paths`、`release_paths`、`submit_handoff`、`post_note`、`ask_human`、会议的 `submit_proposal` / `submit_critique`。和产品无关。
- **ACP（控制层）**：只用于桥自己启动的后台 worker。适合不需要你在桌面应用里看着的活，例如批量审查、跑测试、整理会议纪要。桌面版里的会话仍然由你自己开，桥不去控制它们。

这样就有两类成员：**桌面成员**（你开的会话，桥按门铃）和 **后台成员**（桥用 ACP 开的会话）。面板上一视同仁。

## 6. 文件租约（看板并行的前提）

看板允许不同 AI 同时做不同任务，但它们共用一个工作目录，所以需要租约：

- 开工前调用 `reserve_paths(globs, exclusive, ttl)`。和别人的独占租约冲突时，返回占用者和到期时间，并给双方发一封"文件冲突"信。
- **git 提交只提交本任务租约范围内、且在 `files_changed` 里的文件**，不再用 `git add -A`。并行时用 `-A` 会把别人做到一半的改动一起提交。
- 任务完成或被打回时自动释放租约；租约到期前没有续期，在面板标黄。
- 可选：安装 pre-commit 守卫，挡住 AI 手动提交时碰到别人独占文件的情况。

## 7. 会议与任务

- **会议**：提案 → 互评（可以多轮，你决定何时停）→ 定稿 → 分派。每一轮都给所有到场成员发一封"会议邀请"信，信里带上一轮的全部内容；剪贴板成员走复制粘贴。
- **会议产出**：定稿时写入 `<项目>/doc/meetings/<日期>-<议题>.md`，内容包括议题、各方提案、各轮互评、你的决定、任务清单。这个文件随第一个任务一起提交进 git。目录可以在配置里改。
- **任务**：`id`、`title`、`owner`、`reviewer`、`depends_on[]`、`paths`（预计改动范围，开工时用来申请租约）、`status`。依赖全部完成后，任务才进入"可开工"，然后给负责人发分派信。看板上用连线或"等 T1"标签显示依赖。
- 每个 AI 一次只做一个任务；不同 AI 可以并行。任务内部仍然是"做 → 审查 → 你审批"，复用现在的状态机。

## 8. 从 M1 迁移

- 保留：存储层、身份绑定、git、配置、面板骨架。
- 替换：`wait_for_my_turn` 改为 `wait_for_mail`（只给没有门铃的成员用）；"流水线 run"拆成"会议 + 任务 DAG"。现在的固定流水线变成一种任务模板（规划 → 编码 → 审查）。
- 新增：邮局（信件表、回执表）、门铃程序、文件租约、会议引擎、Windows 通知。

## 9. 先做的两个实测

| 编号 | 验证什么 | 怎么做 | 成功标准 |
|---|---|---|---|
| S1 | Claude 桌面版能否被门铃唤醒 | 写一个最小的 stdio MCP 程序，由 Claude 启动；它向 `CLAUDE_CODE_MESSAGING_SOCKET` 写入 auth 帧和一条 user 消息 | 一个空闲的 Claude 会话收到这条消息并开始工作；记录 Windows 命名管道上的帧格式和版本要求 |
| S2 | Codex 桌面版有没有推送入口 | 查 Codex 的 hooks 文档；试试托管守护进程的 `thread/loaded/list` 能否看到桌面版的线程 | 有入口就接上；没有就确认用长轮询 |

S1 成功，Claude 一侧就彻底不用轮询。S2 不论结果如何，Codex 都已经有能用的方案。

### S1 结果（2026-11-19）：通过

- 环境：Windows 11，Claude 桌面版 Code 标签页（`CLAUDE_CODE_ENTRYPOINT=claude-desktop`）。
- 程序：`spikes/s1/doorbell.mjs`，一个 stdio MCP 服务器，由测试会话通过 `spikes/s1/.mcp.json` 启动。
- 子进程拿到了 `CLAUDE_CODE_MESSAGING_SOCKET`（Windows 命名管道 `\\.\pipe\LOCAL\cc-msg-…`）和 `CLAUDE_CODE_MESSAGING_TOKEN`。
- 帧格式与 open-agent-bridge 一致，Windows 上同样可用：先发 `{"type":"auth","token":…}`，再发 `{"type":"user","message":{"role":"user","content":…}}`，每帧一行 JSON（NDJSON）。管道不回任何数据，约 3 秒后由对端关闭。
- 结果：已空闲的测试会话被立即唤醒，按消息内容回复后自行结束回合。
- 注意：Claude 把注入的消息标成"另一个 Claude 会话发来的消息"，按同伴请求对待，不当作用户授权。这正合适：门铃只负责叫醒，真正的任务内容让 AI 用 MCP 工具从桥上取。
- 风险：这是 Claude 内部接口，没有官方文档，版本更新后可能变化。门铃发送失败时要自动退回长轮询，并记录失败原因。

### S2 结果（2026-11-19）：通过

- 环境：Windows 11，ChatGPT 应用里的 Codex（桌面版），项目 `spikes/s2`，项目级 `.codex/hooks.json`（需要信任项目并审查 hook）。
- 程序：`spikes/s2/stop-hook.mjs`。测试时用一个触发文件代替桥的信箱。
- 时间线（UTC）：
  - 02:26:18：Codex 回复"就绪"，Stop hook 开始等信（`stop_hook_active=false`）
  - 02:26:38：信到，hook 返回 `block`
  - 02:26:41：Codex 回复"门铃已收到"，Stop hook 再次触发（`stop_hook_active=true`，同一个 turn_id）
- 结论：从 hook 返回到 Codex 回复约 3 秒。等信期间模型完全不运行，不花额度。继续的内容仍然算同一轮（turn_id 不变），而 `stop_hook_active` 会一直保持 true，所以 hook 不能靠这个标志判断"是不是死循环"，要用桥这边的投递记录来判断。
- 设计取舍：
  - hook 超时（文档默认 600 秒，未写上限）前没有信时，有两种处理：(a) 放行，Codex 真正停下，之后靠兜底 B；(b) 返回一个极短的 block（"没有新信，直接结束本回合"），让 Codex 花一次很小的调用，重新进入等待，相当于每隔一个超时周期发一次心跳。默认选 (b)，超时设为 3600 秒，也就是每小时最多一次很小的调用；两种都可以在配置里改。
### S2b 结果：用户插话会被挡住，且 hook 收不到任何信号

- 现象：hook 停靠期间你能在 Codex 里输入，但回复明显变慢。
- 原因（日志确认）：hook 停靠时，Codex 把你的输入排在 hook 后面，直到 hook 结束才处理。
- 尝试的两个信号都没用：
  - A：`UserPromptSubmit` 在 hook 放行**之后**才触发（02:42:04 放行，02:42:06 触发），停靠期间不触发。
  - B：等待期间会话记录文件没有任何增长（`transcriptGrew:false`）。你的输入只在 Codex 内存里排队。
- 结论：hook 无法感知你在插话，停靠窗口有多长，你的插话最多就要等多久。

### 由此确定的 Codex 用法（已与用户确认：给工作线程发消息统一走面板）

1. **只停靠"桥的工作线程"**：Stop hook 先问桥"这个 session_id 有没有 join 过桥"。只有 join 过的线程才停靠，你自己在同一项目里开的其他 Codex 对话照常结束、不受影响。
   - 实测佐证：S2 的测试 hook 没有做这个判断，信任后，该项目里**每个**新对话结束时都会停靠；没信任 hook 的对话则不受影响。所以正式版必须有这个判断。
   - 怎么知道这个线程 join 过：桥的 `join` 工具拿到的是 MCP 会话 id，hook 拿到的是 Codex 的 `session_id`，两者不同。办法是 hook 读取 stdin 里给的 `transcript_path`（会话记录 jsonl），查找本线程有没有调用过 bridge 的 `join`，并取出 agent_id，然后向桥登记"这个 Codex session_id 属于 codex"。每个线程只需要查一次，结果缓存。
2. **想和工作线程说话，就走桥**：在面板上给 Codex 发消息（追问、打回、补充说明），这些都变成信件，hook 立刻收到并通过 `block` 交给 Codex，没有任何延迟。这正是邮递员的初衷：人和 AI 都通过信箱沟通。
3. **面板提供"放行"按钮**：如果你还是想直接在工作线程里打字，先在面板点"放行 Codex"，桥会让 hook 立即放行，你的输入马上被处理；处理完后 hook 自动重新停靠。**实测：hook 停靠时，在 Codex 里点停止（暂停）再重新输入，和平常一样秒回**，所以在工作线程里直接打字也没问题：先点停止再说话即可。等这一轮结束后，hook 会自动重新停靠。
4. **停靠窗口**：10 分钟，超时时用一次很小的 block 重新停靠（心跳）。所以就算忘了点放行，插话最多也只等 10 分钟。

### 结论：Claude 和 Codex 都不需要模型层面的轮询了

| 成员 | 门铃 | 等信时的成本 |
|---|---|---|
| Claude 桌面版 | 消息套接字注入（S1） | 0 |
| Codex 桌面版 | Stop hook 停靠（S2），只停靠 join 过桥的工作线程 | 0；每个停靠窗口（默认 10 分钟）最多一次很小的心跳调用 |
| 两者都失败时 | `wait_for_mail` 长轮询兜底 | 30 分钟约 1% 额度（M0 实测） |

## 10. 里程碑（替换 DESIGN.md 里的 M2–M4）

| 阶段 | 内容 |
|---|---|
| M2a ✅ | S1、S2 实测 |
| M2b ✅ | 邮局 + 回执 + 去重；Claude 门铃（stdio 转接程序注入消息）；Codex 门铃（Stop hook 停靠）；`wait_for_mail` 兜底；Windows 通知 |
| M2c ✅ | 会议引擎（多轮互评、写入 doc/meetings）+ 任务 DAG + 文件租约 + 按任务范围提交（见第 13 节） |
| M2d | 按原型实现面板：圆桌、看板（含依赖）、审批、笔记 |
| M3 | ACP 后台成员：Antigravity、DeepSeek Harness；剪贴板成员暂缓 |

## 参考

- open-agent-bridge：https://github.com/kevinArgueta96/open-agent-bridge
- mcp_agent_mail：https://github.com/Dicklesworthstone/mcp_agent_mail（Python 版已进入维护模式，后续版本在 mcp_agent_mail_rust）
- Agent Client Protocol：https://agentclientprotocol.com
- Claude Code channels：https://code.claude.com/docs/en/channels
- Codex app-server：https://developers.openai.com/codex/app-server

## 11. M2b 首次真实运行（2026-11-19，项目 AnytimeMusic）

目标："在应用里加一个「关于」对话框，显示应用名和 package.json 里的版本号"。默认流水线，Claude 桌面版（stdio 转接程序）+ Codex 桌面版（Stop hook）。

| 时间（UTC） | 事件 |
|---|---|
| 03:18:28 | 开始任务，plan 任务信排队（Claude 尚未加入） |
| 03:18:45 | Claude 经转接程序 join，门铃 = Claude 消息注入，立刻按铃 |
| 03:19:47 | Claude 提交规划 → 自动提交 `c552061`，等审批 |
| 03:19:58 | 你批准 → implement 任务信 → Codex 门铃响，但 Codex **没有醒**（缺陷 1） |
| 03:24:13 | 你在面板上问 Claude「还在线吗」→ 门铃 → 9 秒后 Claude 回复并确认 |
| ~03:25 | 你在 Codex 里手动叫醒；Codex 取信、编码、浏览器实测 |
| 03:31:43 | Codex 交接 → 自动提交 `27fd644` → review 任务信 → Claude 门铃 |
| 03:31:49 | Claude 取走 review（6 秒） |
| 03:33:30 | Claude 审查通过（类型检查、67 项测试、浏览器实测） |
| 03:33:41 | 你批准 → 任务完成。全程约 15 分钟，其中两位 AI 的空等成本为 0 |

此后 Codex 用修好的 hook 正常停靠（面板"待命 ●"）。

### 发现的问题

1. **（已修）Codex hook 的输出被截断**：Windows 上 Node 写管道是异步的，`process.exit()` 抢在输出送达前退出，Codex 收到空回复就结束了这一轮。改为写完再退出。
2. **（已修，重启桥后生效）送不出去的信没人提醒**：Codex 没停靠时，信一直"待投递"。现在超过 `ring_retry_seconds` 仍送不出、对方又不在干活，就标为"送不到"并通知你。
3. **（待改）刚 join 就按铃是多余的**：join 协议本来就让 AI 先 `fetch_inbox`，所以刚 join 就按的那一声铃会多出一个空回合。计划：join 后留 15 秒宽限期，期间不按铃。
4. **（模型行为）回答状态不新鲜**：Claude 被问「还在线吗」时说"规划等你批准"，实际上已经批准过。可以考虑在 `[协作桥]` 叫醒消息或 `fetch_inbox` 结果里附上一行当前任务状态。
5. **（偏好）交接单语言**：Codex 用英文写摘要。在启动提示词里加"交接单用中文"即可。

## 12. M2b.1：按两边 AI 的反馈改进（2026-11-19）

反复打回测试（MultiAiTestProj，4 次打回全部自动流转）之后，Claude 和 Codex 各自提了意见，落实如下：

| 来源 | 反馈 | 改动 |
|---|---|---|
| Claude | 返工后的复审任务里 `feedback` 是空的，要翻 `get_context` 才知道这轮用户要什么 | 返工阶段完成后，它的反馈以 `kind: "carried"` 原样带进下一次审查 |
| Codex | 用户要求、阻塞问题、非阻塞观察混在一个字段里 | `feedback` 改为结构化：`user_requirements`（必须做）、`blocking`（必须修）、`observations`（可选）。审查交接单新增 `observations` 字段；`review_comments` 只写阻塞问题。只有审查结论是 reject 时，`review_comments` 才算 blocking |
| Claude | `get_context` 越来越长 | 默认只返回最近 3 份完整交接单（`last_n` 可调），更早的只给一句摘要；新增 `current_round` |
| Claude | 审查没有提交，`git log` 看不到结论 | 带 verdict 的交接即使没改文件也生成空提交，标题带"审查通过 / 审查打回"，正文列出阻塞问题和观察（`git.commit_reviews`） |
| Claude | 编码阶段也改了 PLAN.md | 阶段可声明 `owns`（默认规划阶段负责 `PLAN.md`、`docs/**`、`doc/**`）；其他阶段改了这些文件时，审批卡片显示范围提示（不阻止） |
| Codex | 自动提交可能带上不相关的改动 | 提交前用 `files_changed` 核对实际改动，没声明的文件列进范围提示（卡片 + 提交正文） |
| Codex | 身份被占用时只能干等重试 | join 被拒时返回旧会话的空闲秒数、预计自动释放时间和可选做法；面板成员表显示绑定时间和「释放」按钮；新增 `leave` 工具 |

## 13. M2c：会议、任务 DAG、文件租约、按任务提交（2026-11-19）

和第 6、7 节的草案相比，实际做法如下：

| 部分 | 做法 |
|---|---|
| 运行模型 | 一次运行（run）由若干**任务**组成（`tasks` 表：编号、负责人、审查人、依赖、paths、各自的阶段链）。「开始（流水线）」是只有一个任务 T1 的运行，阶段链就是 `pipeline`，行为和 M2b.1 一样。会议定稿的任务用 `task_template`（默认：负责人实现 → 审查人审查，审查需人工批准，打回回到实现；没有审查人就跳过审查）。旧数据库启动时自动给每个 run 补一个 T1 |
| 调度 | 依赖全部完成、且 paths 不和别人的租约冲突的任务立即开始；冲突的显示「等文件租约」，每 5 秒的 sweep 会重试。每个 AI 一次只领一个任务：手上有进行中的阶段时，下一封任务信先不发 |
| 会议 | 第 1 轮提案（所有参会者）→ 你决定再互评一轮或定稿 → 定稿只发给主持人，必须带任务清单（桥校验编号、成员、依赖和环）→ 你批准或打回定稿。每一轮是一封 `meeting` 信，内容在取信时生成（含之前各轮全部发言和你的意见），轮次过了的信自动作废。会议期间不能开始流水线，反之亦然 |
| 会议纪要 | 批准时写入 `meetings.dir`（默认 `doc/meetings/<日期>-<议题>.md`），并**单独提交**这一个文件，没有像草案那样等第一个任务一起提交：纪要是任务的输入，先提交更清楚，也不会和并行任务的提交搅在一起 |
| 文件租约 | 任务开始时自动独占租下它的 paths，任务结束（或运行停止）时释放，不过期。AI 用 `reserve_paths` 申请额外文件（默认 1 小时，再调用即续期），`release_paths` 提前释放。冲突时不授予，返回占用者，并给占用者发一封「文件冲突」信。过期的手动租约不再算数，面板标黄 |
| 按任务提交 | 任务声明了 `paths`、持有租约或有其他任务并行时，提交本任务范围内或交接单声明、且未被其他任务租用的改动（`git add -A -- <路径>` + `git commit --only`）。只有一个普通任务且未声明路径范围或租约时，继续使用 `git add -A`。审查仅提交声明的改动，未声明改动的审查可用空提交记录结论 |
| 没做的 | pre-commit 守卫（AI 手动 `git commit` 时挡住别人的独占文件）；剪贴板成员参会（M3） |

## 14. M2c 首次真实运行（2026-11-19，MultiAiTestProj，会议 #1 → 运行 #3）

议题：给 todo 命令行加 Markdown 导入导出和截止日期。两轮讨论（提案、互评）后定稿 4 个任务（T1 截止日期模块、T2 导出模块并行；T3 接入 CLI 依赖两者；T4 README），全部完成。

### 发现的问题

| 问题 | 原因 | 处理 |
|---|---|---|
| Codex 经常叫不醒，用户要在 Codex 里说「继续」 | 桥按铃约 8 次，hook 都返回了 `block`，但 Codex 会话记录里只有 2 次 `HookPrompt`；其余几次 Codex 在 0.5～1 秒内直接结束了这一轮。其中两次是同一轮里的第二次 block（疑似 Codex 一轮只认一次），另外四次原因未明（成功的两次 hook 都停靠了约 3 分钟） | hook 把完整 stdin（含 `stop_hook_active`、`turn_id`）、停靠时长、信件 ID 和输出写入 `%TEMP%\ai-bridge\codex-stop-hook.jsonl`，下次复现即可定位；响铃后 Codex 若没有任何工具调用、也没取信、hook 也不在等（默认 20 秒，`BRIDGE_CODEX_WAKE_GRACE_SECONDS`），面板提醒并弹通知，不再等 2～4 分钟的 sweep |
| Codex 重开 MCP 转接程序后「身份被占用」 | 用户中断并编辑消息后，Codex 重启了转接程序，旧 MCP 会话没有退出 | 转接程序在 stdin 关闭时发 MCP `DELETE`，桥释放旧会话的绑定。若 Codex 是直接结束进程，这一步不会发生，待日志确认 |
| 审查提交带进了用户的 IMPORTANT.md | 只剩一个任务时走了 `git add -A` | 有 `paths` 或租约的任务一律按范围提交；审查只提交声明的文件 |

### 直接门铃调研：app-server 控制套接字不可用

Codex 0.170 桌面版常驻一个 app-server，控制套接字在 `~/.codex/app-server-control/app-server-control.sock`，可以连上。但它是独立的托管 App Server：向桌面对话 `turn/start` 返回 `-32600: thread not found`，桌面对话保持空闲。桌面对话由桌面应用自己的 App Server 持有。让托管服务另行载入同一对话会出现两个写入者，所以不采用。**Codex 的门铃继续用 Stop hook。**

### 两边 AI 的其他反馈（`MultiAiTestProj/IMPORTANT.md`）

- 会议信每轮都附全部历史，定稿轮很大：只给上一轮全文，更早的给摘要或纪要路径。
- `join` 返回里提示需要预加载的工具（Claude 里它们是延迟加载的）。
- 范围提示区分「工作区原有改动」和「并行任务的半成品」。
- 任务描述的勘误入口；共享的、不提交的工作区（如 `.bridge/shared/`）放验收脚本。
- 只需确认的用户消息，在叫醒提示里直接带正文摘要。

## 15. 门铃驱动与 Codex 队列门铃（0.5，2026-11-19）

### 为什么换掉 Stop hook 停靠

日志证明 Codex 收到 hook 的 `block` 后经常直接结束这一轮：两次测试中 9 次 block 只有 2 次生效（那两次 hook 都停靠了 2 分钟以上），其中一次是这一轮的第一次 block（`stop_hook_active=false`），所以「一轮只认一次」也解释不了。网上没有找到这个现象的说明。

`codex queue --thread <对话ID> --message <文本>`（Codex CLI 0.149 起）往 `~/.codex/queue_1.sqlite` 排一条消息，桌面版自己会处理这个队列，你在 Codex 忙的时候追加的消息也走这里。实测（Codex 0.170）：空闲对话约 6 秒后开始新一轮，记录里是 `turn_trigger: "queue"`，和你打字是同一条路，不会被丢。但 hook 停靠期间这一轮没有结束，排队的消息要等 hook 返回，所以用队列时 hook 不能再停靠。

### 结构：引擎不认识任何产品

```
引擎：有信给 X → kick(X)
  └─ Doorbells.pick(X)：按 X 的门铃顺序，取第一个现在能送达的
       ├─ claude-socket   停靠式：转接程序长轮询，有铃时往 Claude 消息套接字注入
       ├─ codex-queue     执行式：桥运行 codex queue
       ├─ codex-hook      停靠式：Stop hook 长轮询，有铃时返回 block
       └─ poll            AI 自己 wait_for_mail（总在最后）
  按铃失败 → 信退回、换下一个；按铃成功 → 30 秒内看有没有任何工具调用，没有就换下一个，都不行再通知你
```

- 每个驱动实现同一组接口（`src/doorbells/types.ts`）：`possible`（能不能为这个成员服务，决定 join 怎么交代）、`available`（现在能不能送达）、`armed`、`ring`、`waitInstructions`，以及 `sessionless`（成员不需要开着的 MCP 会话也能叫醒）和 `verify`（按铃后要不要确认）。
- 门铃顺序：`agents.<id>.doorbell` 可以写列表、单个门铃或 `auto`；`auto` 按 `product` 取默认值（`src/products/`）。
- 成员登记：通用的 `agent_endpoints` 表和 `POST /api/agents/:id/endpoint`，取代 `codex_threads` 和 `/api/codex/thread`（旧路由保留给旧 hook）。Codex 的 Stop hook 每轮结束时登记对话 ID；桥回答 `park:false` 时 hook 立即放行，`park:true`（找不到 codex 命令、排队失败过、配置不用队列）时 hook 照旧停靠，作为兜底。
- 防止叫醒旧对话：成员如果在登记之后又从新的 MCP 会话加入（多半是新开的对话），旧的对话 ID 不再使用，等新对话第一次结束一轮重新登记。
- 不重复排队：Codex 队列里已经有这个对话的消息时不再排。
- 失败处理：`codex queue` 失败后 10 分钟内不再用它，下一次 Stop hook 会停靠作为兜底；没有别的门铃可用时立即通知你。

### 产品档案与引擎拆分

- 产品档案负责各产品的 setup、uninstall、doctor 和默认门铃顺序。Codex 的 doctor 检查队列门铃能否找到命令。

- `engine.ts` 组装邮局（`postman`）、身份与在线状态（`presence`）、任务调度（`scheduler`）、会议（`meetings`）和租约（`leases`）。`workspace` 提供项目上下文和面板状态。

## 16. 聊天（M2d 前置，2026-11-19）

面板的「会议室 + 轻聊天」设计需要 AI 能在任务和会议之外简短回话，并且你能看到每条消息谁读了。

- **一条消息存一次，投递靠信件。** `chat_messages` 表存消息（发送者、正文、被投递的成员、`reply_to`、当时的 run 和会议）。每个被点名的成员收到一封 `chat` 信，id 是 `chat-<消息号>-<成员>`，不需要 ack。这封信的状态就是回执：待投递 → 已按门铃 → 已读（取走即已读）。门铃、重按、送不到、"排队中"都沿用邮局原有的逻辑，聊天不需要自己的投递机制。
- **点名。** 显式 `mentions` 加正文里的 `@名字`。正文按已知成员名做最长前缀匹配，所以中文紧跟在名字后面也能识别（`@claude你好`）。`@all` / `@全体` / `@所有人` 是所有成员。用户发的消息必须点名；成员不点名就只给用户看。回复另一个成员的消息时，不用 @ 也会送到原作者。
- **收住话题。** `say(wake=false)` 只记在聊天里，谁都不叫醒（运行 #5：Claude 回复 Codex 说「聊到这儿」，回复规则又把 Codex 叫醒了一次）。`say` 的说明写明谁会被叫醒，以及下面的防刷屏规则。
- **防刷屏。** 从用户最后一条消息算起，成员已经连续发了 `chat.max_agent_turns`（默认 6）条时，新消息照样记下，但 @ 不再叫醒任何人，`say` 的返回里说明原因。用户插一句话就重新计数。
- **AI 这边。** 新工具 `say(text, mentions?, reply_to?)`。`fetch_inbox` 里的 chat 信带消息本身、被回复的消息和前 `chat.history`（默认 10）条聊天，并提醒它手上有任务时先做任务。`get_context` 带最近 10 条聊天。
- **面板。** 「聊天」卡片按时间显示消息和每个收件人的回执，带 @ 快捷链接和回复。「成员」表的发消息框（`POST /api/mail`）现在是一条只点名该成员的聊天，取代原来需要 ack 的 `human` 信。新接口 `POST /api/chat {text, mentions?, reply_to?}`。

运行 #5 还发现：桥重启后、Codex 在新对话里 join 之前，队列门铃用了数据库里上一次登记的对话 ID，把叫醒消息排进了用户的旧对话。现在桥启动前登记的对话 ID 不再使用，Codex 重新 join 或 Stop hook 重新登记之后才会用队列门铃叫醒它。

## 17. 会议室面板（M2d，0.6）

面板换成画布上的「会议室 + 轻聊天」设计：

- **三栏。** 左栏是成员（状态、手上在做什么、门铃和是否接通、未取/排队/送不到/叫不醒、释放）和发起入口（开会讨论、直接开始流水线、停止）。中栏是房间时间线和输入框。右栏是会议进度（提案 → 互评 → 定稿 → 批准）、任务卡、文件租约、共享笔记和最近任务。窄屏时右栏移到下面，手机上时间线排最前。
- **时间线是服务端的读模型**（`engine/room.ts`）。按时间合并：聊天（带每个收件人的回执）、会议每一轮一张卡（当前一轮带你的操作：跳过没发言的、再互评、请定稿、批准或打回定稿、取消会议）、交接卡（待审批的那张直接带批准 / 打回和备注框）、未回答的问题、系统事件。会议发言、"等待你审批"和门铃事件已经体现在卡片或成员栏里，不再单独显示。每一项带分类，顶部按全部 / 聊天 / 会议 / 任务筛选，问题卡在任何分类下都显示。
- **输入框。** 选「发给」谁（可多选，或所有人），也可以在正文里 @。下面一行按成员的实时状态说明会怎么送达：用哪种门铃叫醒、正在做任务所以排队、还没加入、不在线。Enter 发送，Shift+Enter 换行，点消息上的「回复」带上 reply_to。
- **实现。** 面板是 `panel/` 下的静态文件，不再写在 TS 模板字符串里（之前的转义问题就出在这里）。按钮用 `data-act` 加一个委托的点击处理。旧面板留在 `/classic`。

## 18. 运行 #6：Claude 掉线（2026-11-19）

Codex 全程靠队列门铃，没有出问题。Claude 掉了三次，每次都要用户在 Claude 对话里提醒。

- **原因。** Claude 桌面版会关掉闲置对话的进程，转接程序和消息套接字跟着一起没了。日志里 Claude 的 MCP 会话在 14:20:54、14:23:54、14:26:54 依次关闭。对话重开后换了新的消息套接字，按套接字缓存的身份对不上，转接程序没法重放 join。下一次工具调用时，桥会恢复身份，但没有把门铃接回来：返回的说明还是轮询的说法，转接程序也没重新长轮询，所以下一封信照样叫不醒。
- **修复。** 转接程序在每个 MCP 请求上带 `x-bridge-doorbell: claude-socket`，桥按会话记下来。任何工具调用恢复身份时，都直接把 Claude 门铃登记回来，返回里写明门铃类型和对应的等信说明。转接程序看到 `identity_recovered` 后，在后台补一次 join，给新套接字缓存恢复用的 key，并重新开始长轮询。
- **对话关着时。** 桥叫不醒一个已经关掉的 Claude 对话，这一点改变不了。现在，排队超过 15 秒（`BRIDGE_UNREACHABLE_ALERT_SECONDS`）、又没有门铃能送达的信，会立刻在面板和通知里提醒用户，原来要等 2 分钟才提示。信继续排队，对话一回来就能取走。
- **Codex 空回合。** 两封信间隔约 5 秒，第二次响铃时第一条 `codex queue` 还在运行，还没写进队列，结果排了两条叫醒消息。现在同一个对话有 `codex queue` 正在运行时，不再排第二条。

## 19. 后续设计草案

- **审查阶段的独立依赖**。在任务清单中为审查阶段声明前置任务及所需阶段，例如 T2 的审查等 T1 的实现交接。调度时分别检查任务依赖和阶段依赖，校验组合后的依赖图是否成环。派审查信时记录满足条件的那份交接和 SHA。上游返工后，新派发的审查引用最新有效的实现交接。
- **任务描述勘误**。在任务卡上提供修订说明的入口，由用户填写新版本和原因。面板保留旧版本与修订记录，并给负责人和审查人发信。新任务信读取最新文本，既有交接保留它依据的版本号。
- **共享工作区**。按运行和任务号创建 `.bridge/shared/<run>/<task>/`，借用 `.bridge/.gitignore` 排除临时脚本和样例。任务信提供项目内的相对路径，方便实现方和审查方使用同一份文件。
- **返工复现命令**。审查交接可以随阻塞问题提供复现命令、执行目录和预期结果。审批卡展示这些信息，返工信原样带上，方便接手人复跑。

## 20. 面板 P1：三视图与待你处理

0.7 的 `/` 默认进入 Chat。Chat 显示对话、回执和可跳转的事件摘要，Meeting 用当前轮次做讨论和决策工作区，下面是任务、依赖、交接和租约。Office 用静态工位显示成员状态及依据，也能进入会议信息和审批抽屉。`/v1` 仍提供 0.6 的会议室，`/classic` 提供经典面板。三个入口共用守护进程和同一份 `/api/state`。`/v1` 将新的 `delivery` 时间线条目显示为系统消息。

- **`snapshot().inbox`** 由 `engine/room.ts` 从时间线派生。交接审批复用卡片的 `gate`，定稿审批来自 `awaiting_approval` 轮次，发言齐后的决定来自 `review`，待答问题来自 `openQuestions()`。`collecting` 阶段显示欠发言的成员。现有超时分别针对门铃投递和取信后确认，因此会议待办采用 `review`，没有额外的轮次超时判断。
- **投递异常** 由 `workspace.ts` 按成员计算一次。`stuck`、叫不醒，以及轮到该成员但尚未加入或离线时，生成送达提示，供待办、成员详情和旧版 `attention` 使用。成员正忙而排队的信沿用排队回执。`attention` 保留原来的单条提示和优先级。
- **待办定位**。`ref` 指向交接、会议轮次、问题或送达提示，对应卡片使用同一份内容。`target` 包含视图与稳定锚点。待审批和投递异常优先，优先级相同的事项按最早发生的排在前面。时间线保留当前会议和任务的卡片与所有待处理上下文，超过历史上限时优先缩减其他历史记录。
- **`agents[].activity`** 由 `engine/activity.ts` 派生。依次检查送不到或叫不醒、Presence 的未加入／离线／连接待确认、当前轮是否欠发言、是否有交接等你审批、是否在执行已领取的阶段，最后是待命或状态待确认。审查阶段用已知审查角色或阶段标记识别。`ready` 只增加「有任务待领取」证据。`since` 取实际记录中的时间，例如任务领取、交接提交、会议信发送或最早一封异常信的创建时间。依据最近活动的状态与成员详情共用 `lastSeenAt`。
- **静态模块**。`panel/index.html` 加载 `app.css` 和 `js/main.js`。`state.js` 从 `/api/stream` 的 SSE 提示刷新 `/api/state`，每 5 秒兜底，并按订阅区域比较快照。`router.js` 用 `#/chat`、`#/meeting`、`#/office` 与 `anchor` 参数定位卡片。`model.js` 投影数据，`cards/` 在视图和 `inbox.js` 间复用卡片。视图在本页内保持 DOM、滚动与展开状态，`data-keep` 让同一审批或问题在两处共享草稿。`actions.js` 通过原有 POST 接口提交，提供就地错误反馈和停止、取消、释放等动作的确认。
- **直达与滚动**。三个视图起初均隐藏，路由从地址栏选择唯一的视图。可直接打开并刷新 `/#/meeting` 或 `/#/office`，确认内容和导航一致。Chat 首次显示时跟随最新消息，明确指定的锚点优先，回来时恢复已保存的滚动位置。

## 21. P2 一键加入和门铃加固

本机 Codex 0.171.0 已在临时用户目录通过 `skills/list` 识别 `~/.codex/skills/bridge`。实际桌面会话的命令菜单、调用和叫醒在安装后验收。

- **加入与取信**。MCP 公开 `join` 和 `inbox` 两个提示词，stdio 转接程序转发 `prompts/list` 与 `prompts/get`，两侧握手版本取 `package.json`。省略 `agent_id` 时按 `agents.*.product` 找唯一匹配，歧义或无匹配时返回候选，沿用原会话绑定与显式接管机制。转接程序以 `x-bridge-client` 转发下游初始化名称，直接连接可用自己的 `clientInfo.name`，Claude 套接字变量优先作为产品线索。用隔离配置让本机 Claude Code 2.1.326 和 Codex 0.171.0 连接开发守护进程，其 `mcp_session_open` 日志中的 `upstream_client` 分别为 `claude-code` 和 `codex-mcp-client`。 [MCP 提示词规范](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- **Skill 生命周期**。`setup` 安装 `~/.claude/skills/bridge/SKILL.md` 和 `~/.codex/skills/bridge/SKILL.md`。Claude 用 `disable-model-invocation`，Codex 用 `agents/openai.yaml` 的 `allow_implicit_invocation` 控制为显式调用。按文件所有权标记识别，更新和卸载前备份。`--refresh` 要求对应 bridge MCP 和托管 skill 已存在，只刷新已有托管文件。 [Claude Code 调用控制](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill) [Codex 调用策略](https://learn.chatgpt.com/docs/build-skills#optional-metadata)
- **版本提示与探针**。`agents[].product` 提供版本、提示和代理报告。Codex 优先从所选 release 目录取版本，其他命令用 `--version`。Windows Claude 从本用户安装的 AppX 包读版本，取不到时为 `unknown`。已确认的门铃版本前缀：Codex `0.170`、`0.171`，Claude 桌面版 `6.6395`。`0.171.0` 的 release 在 run #1 期间才出现，队列门铃又会缓存已经选中的命令，所以旧运行的成功记录不能算数；0.8.0 安装后（2026-11-20）用 `$bridge` 和 `/bridge` 加入，两边各叫醒一次并确认醒来，才把这两个版本加进列表。2026-11-21 两个产品自动更新后补入：Claude 桌面版 `6.28899`（0.10 重启后 run #7 里被 claude-socket 叫醒并取信 12 次），Antigravity `1.5.14`（会议 #3 和 run #7 的 ACP 回合都以 `end_turn` 正常结束；ACP 档案原有 `1.5.13`，DeepSeek Harness 为 `0.2.2-rc.5`）。`doctor --probe` 仅读命令帮助、SQLite、最近的 Codex 会话记录和 `/api/state` 的代理报告。Claude 代理报告套接字变量与管道存在性，检查阶段只查看管道目录，无需连接管道。
- **格式变化**。Stop hook 和探针共用 `bin/codex-transcript.mjs`。仅根据结构化工具记录判断 join 痕迹。无法识别时，hook 向本机 `POST /api/diagnostics/codex-transcript` 报告，服务端优先按已有线程端点关联成员，其次选唯一 Codex 成员，其余显示产品级诊断。队列数据库存在但读取失败时每个守护进程记一次 `drift`，队列投递沿用原路径。运行中的诊断进入成员详情与 `inbox`（`kind: diagnostic`，普通优先级）。`drift` 事件含产品与版本，活跃提示与统计从守护进程启动开始累计。
- **安装版本复查（0.8.1）**。生成快照时按产品检查缓存，到期后异步探测，每个产品同时只运行一次。已知版本默认 600 秒后复查，`unknown` 或探测失败默认 60 秒后重试。分别用 `BRIDGE_VERSION_REFRESH_SECONDS` 和 `BRIDGE_VERSION_RETRY_SECONDS` 覆盖。复查期间及探测失败后沿用最近一次已知版本，检测到版本变化时通知面板刷新。队列格式诊断记录实际执行响铃的命令版本。
- **唤醒统计与降级**。`Doorbells` 注册表按成员和驱动记录响铃、确认与异常，快照提供 `agents[].doorbellStats`。使用已有队列唤醒的去重请求不计新响铃。可验证门铃以宽限期内的工具调用或成员正在工作作为确认信号。0.8.1 在当前连续异常序列里分开记录响铃失败（`ringFailuresInStreak`）和响铃后未确认（`unconfirmedInStreak`），Office 用分项生成提示。`consecutiveFailures` 是两类的合计，达到 `doorbells.max_unconfirmed_rings`（默认 3）时跳过该门铃 `doorbells.cooldown_seconds` 秒（默认 600），按原顺序选择下一个可用门铃。队列执行失败会立即降级。确认、交付或冷却结束时清零连续计数，`failed` 记录两类异常的累计次数。降级和恢复各记一次事件，恢复后重试仍排队的信。
- **安装版本比较**。提交不同时，`doctor` 使用 GitHub Compare API 以 GitHub main 为基准、安装提交为比较对象。只有 `behind` 建议更新。安装提交在 GitHub 尚不可比较时，报告无法判断。 [GitHub Compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)

## 22. P3 工作区与面板（0.9.0）

- **文件夹**。每场会议使用 `m<id>`，批准后生成的运行归在原文件夹。直接流水线使用 `r<id>`。`GET /api/folders?limit=&before=` 按最近活动倒序，用时间和文件夹 ID 组成游标。`/api/folders/:id` 返回任务、阶段和关联事件，当前会议轮返回全文，历史轮返回摘要。用 `?round=` 取对应历史轮全文。交接每页 20 条，首页优先显示待审批项。待审批项本身超过 20 条时，首页完整显示待审批项。
- **状态**。`/api/state` 增加 `folders_head` 和 `now_playing`。文件夹的待处理计数来自 `inbox`。底栏依次优先显示待审批、已领取和待领取的阶段，再到欠发言的轮次。分段条显示当前阶段和开始至今的时间。
- **界面**。`#/home` 展示快捷入口和近期工作，`#/f/<id>` 用 `tab` 与 `anchor` 直接定位。顶栏进入办公室和聊天。详情和待处理共用右栏，窄屏浮动，手机占满主区。主题在手动选择前跟随系统。`data-keep` 草稿按项目保存在本标签页的会话存储中。
- **刷新**。SSE 更新 `/api/state` 和当前文件夹。导航和读取历史页使用 GET，提交沿用原 POST。`/v1` 和 `/classic` 继续提供旧面板。
- **误报和启动**。执行中的任务信在确认窗口内有工具活动时延后提醒。队列门铃在最近 60 秒有工具调用时增加默认 90 秒宽限，由 `BRIDGE_WAKE_TURN_EXTRA_SECONDS` 配置，期间重试扫描也会等待。新纪要使用 `<日期>-m<会议号>-<短标题>.md`。端口占用时 `start` 返回非零，若能读取已有桥的状态则提示该项目和面板。
- **收尾（会议 #2）**。
  - 叫醒确认按调用序号判断：每次工具调用（以及 `wait_for_mail` 返回）让 `presence.callSeq` 加一，按铃时记下当时的序号，`checkWake` 看序号有没有增加。触发按铃的那次调用（例如交接时给自己派了下一阶段）在按铃前已经计数，不算醒；按铃后同一毫秒的新调用算醒。被接管的旧会话的 `wait_for_mail` 结束时不计数。宽限和超时仍按墙钟。
  - `events` 新增可空列 `meeting_id`。会议事件由 `ctx.event(…, meeting_id)` 显式写入。旧库首次打开时按桥历来的事件模板（以「会议 #N 」「你打回了/你批准了会议 #N 」开头，或以该行 agent 加「 在会议 #N 」开头，成员名可含空格）回填一次，模板以外的文字和不存在的会议编号留空。加列和回填在同一个事务里，中途失败会整体回滚，下次启动重来。索引：`events(run_id, created_at)`、`events(meeting_id, created_at)`、`handoffs(run_id)`、`attempts(run_id)`、`meeting_turns(meeting_id)`。文件夹列表按每个运行和会议走索引取最近活动，不再每次聚合全部历史；文件夹事件用 `run_id = ? OR meeting_id = ?`。0.9.0 用文本拼接 `'会议 #' || ?` 匹配会议事件，JS 数字绑定成 REAL 后变成 `#1.0`，没有运行的会议文件夹因此一条事件也显示不出来；改用列以后这个问题一并消失。
  - 纪要短标题里数字之间的点不算标点，`收尾 0.9.0 的问题` 得到 `收尾-0.9.0-的问题`。

## 23. M3：ACP 后台成员（0.10.0，0.10.1 收尾）

- **连接与唤醒**。`agents.<id>.acp` 配置子进程、工作目录、MCP 传输和权限。首次有信时启动，依次执行 `initialize`、建会话及可选的 `session/set_mode`。Antigravity 的 stdio 代理以 `bridge_acp` 注册，避开交互配置中已经加载的 `bridge`。DeepSeek Harness 以 HTTP MCP 直接连接。子进程环境过滤 `CLAUDE_CODE_*` 和桥的其他门铃变量。提示里的工作内容仍然从 MCP 收件箱取得。 [ACP 会话规范](https://agentclientprotocol.com/protocol/v1/session-setup) · [Antigravity MCP 配置](https://antigravity.google/docs/cli-settings)
- **复用与补投**。`agent_endpoints` 以 `acp-session` 保存每个成员的会话 ID。重启进程后按能力尝试 `resume`、`load`，再新建。DeepSeek Harness 的 MCP 插件在守护进程断线后不会自动重连，因此 HTTP 成员跨守护进程重启一律新建会话。每个成员同时只有一个 `session/prompt`。本轮结束时检查没取走的信，每封信至多立即补发一次，后续沿用邮局的重投间隔。
- **交互优先**。阻塞中的 `wait_for_mail` 先取信，最近一次轮询在 `wait.stale_after_seconds` 内也会暂缓 ACP。后台 MCP 以 `x-bridge-agent` 和 `x-bridge-doorbell: acp` 登记身份，桥为它的 `join` 补接管参数。被接管的前台会话会收到「后台会话正在处理协作桥的信」。后台回合领完信后直接结束。
- **取消**（0.10.1）。停止运行、任务被打回替换或信件作废时，对涉及这封信的活动回合发 `session/cancel`，宽限固定为 30 秒（`BRIDGE_ACP_CANCEL_GRACE_SECONDS` 可调），不随代理输出延长。宽限内收到原 prompt 的 `cancelled` 就正常收尾，进程和会话都保留。超时记 `acp_cancel_timeout`，结束进程树，把取走未确认的信退回；这不计失败、不进入退避，原有失败次数不变，下一封有效信懒启动并恢复原会话。每次取消以 `acp_cancel_end` 记下从发出到收尾的耗时（`elapsedMs`）。取消期间该成员的 `fetch_inbox` 返回空、`reserve_paths` 被拒绝，新信留在队列里不消耗响铃次数，回合结束后补投一次，同一会话不会重叠两个 prompt。
- **取消期间的租约保护**（0.10.1）。停止运行或驳回替换时，如果该任务的 ACP 回合还没结束（或它的交接还在做 git 提交），任务的租约保留到回合结束或进程树退出。期间调度器不启动路径与之重叠的任务；没有 `paths` 的任务（可以写整个项目）一律等待；不重叠的任务照常开始。保护只在内存里，守护进程重启时会释放已停止运行的租约。停止之后才到达的交接不再自动提交，改动留在工作区。
- **退避**。进程或协议失败后，两次自动重试分别等待 30 秒和 2 分钟，第三次失败后停止，等手动重启。重试时机只由 ACP 宿主自己的计时器决定，同一次故障只有一个计时器；门铃的通用冷却（`doorbells.cooldown_seconds`，默认 10 分钟）只用于判断唤醒是否健康，ACP 的响铃失败不触发它。停止后台或协作桥退出时先取消正在执行的回合，再按能力发 `session/close`，之后结束进程树。 [ACP 取消规范](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)
- **Windows 进程归属**（0.10.1）。实测：Node（libuv）把非 detached 的子进程放进「关闭即结束」的 Job Object，并允许子进程派生的进程静默脱离。所以守护进程被强制结束时，它直接拉起的代理会被系统立即结束，而非 Node 代理（agy）派生的进程会活下来，此时 `taskkill /T` 已经找不到它们。因此：
  - **监督进程** `bin/acp-supervisor.mjs`：守护进程以 detached 方式启动它，再由它拉起代理。它持有代理的 stdin、stdout、stderr，原样复制字节，不改 ACP 报文；守护进程一侧的 EOF 不转给代理。IPC 断开、stdin EOF 或信号到来时（每秒检查守护进程 PID 只作辅助），先对还活着的代理执行 `taskkill /T /F`，连同它派生的进程一起结束。代理正常退出时，监督进程把输出全部复制完再以代理的退出码退出。`AcpRpc.pid` 仍是代理的 PID，`hostPid` 是监督进程；`doctor --probe` 也经过监督进程，但不写台账。
  - **台账** `<项目>/.bridge/acp-hosts.json`：拿到代理 PID 后立即写一条记录，再补齐守护进程、监督进程、代理三项的精确创建时间（PowerShell CIM，约 0.5 到 1.5 秒），从磁盘读回核对一致后才放行 ACP 报文。写入或身份记录失败时 `initialize` 被拒绝，按启动失败进入退避。代理正常退出时删除记录。
  - **启动清理**：端口绑定后、第一次投递 ACP 前同步执行，台账为空时不调用 PowerShell。只有记录写明了本项目的绝对路径、原守护进程已证实退出（PID 不在，或已归别的进程）时才处理。每次 `taskkill` 前都重新查询目标，PID 和精确创建时间一致（监督进程还要核对命令行含 `acp-supervisor.mjs`）才结束；结束后再查一次，只有确认已不在或 PID 已归别的进程才记 `acp_orphan_killed`。查询失败、身份无法核实、结束未确认的记录都记 `acp_orphan_skipped` 并保留到下次启动。
- **观察与体检**。成员详情显示后台状态、下次重试、最近 50 行代理输出和最近权限决定。代理输出只在内存里保留。启动、初始化、新建或恢复、响铃、结束、权限、退出及取消都有 `acp_*` 事件。工具调用还记录短标题和状态。`doctor --probe --project <目录>` 对每个后台成员只执行 `initialize`。本机探针确认 Antigravity ACP Server 1.5.13 支持恢复、加载和关闭，DeepSeek Harness 0.2.2-rc.5 内置的 ACP 0.0.1 支持 HTTP MCP、恢复和关闭。
- **成员分工**。Antigravity 和 DeepSeek Harness 适合文档、文案、纪要和第二意见。重编码和最终审查继续交给 Codex、Claude。两种产品已有 ACP，剪贴板成员适配暂缓。0.10.1 起可在 `agents.<id>.notes` 写分工说明（去掉首尾空格，不超过 200 字）：提案轮和定稿轮的会议信带 `members: [{id, product, notes}]`，列出配置里的全部成员（包括没参会的），定稿说明提示「分配负责人时参考 members[].notes」；`/api/state` 的 `agents[].notes` 和办公室成员详情也显示它。notes 只供参考，不参与调度和 `validatePlan`。
- **真实演示**。在 7879 的临时 Git 项目中，Antigravity 新建会话 5.157 秒，实现回合 43.391 秒，提交 `9893e93`。DeepSeek 新建会话 1.141 秒，审查回合 15.411 秒，提交 `7a6ed82`，流程进入人工审批。随后 `@deepseek` 的聊天回合 3.106 秒，复用了审查的会话。两个后台进程经面板停止并查到 PID 已退出。DeepSeek 自带 `acp` profile 默认用需要 API Key 的 `deepseek-official`。本仓库向该进程传入 `--patch bridge.deepseek-acp.patch.yaml` 来使用桌面已登录的 `deepseek-account` 路由。 [DeepSeek 账号模型](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers#deepseek-account-models)
- **已知限制**。
  - 代理的根进程自己先退出时，它在 Node Job 之外派生的进程会继续运行，`taskkill /T` 已经找不到它们。监督进程管不到这种情况，只有 Job Object（不脱离的作业）能解决；Node 没有相应 API，需要原生模块或 C# 辅助进程，暂未做。
  - 只结束监督进程（例如在任务管理器里）时，代理在监督进程的 Job 里会被一起结束，但它派生的、脱离了 Job 的进程不在台账里，下次启动也不会清理。
  - Windows 上 `acp_spawn` 事件在代理 PID 报上来之前发出，显示「PID 未知」；成员详情随后显示真实 PID。
  - DeepSeek Harness 的 MCP 插件断线后不会自动重连（见上文「复用与补投」）。

