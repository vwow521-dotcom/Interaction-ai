# 使用说明

协作桥把任务、你的消息、问题答复都当作**信件**投递。有信时，桥按"门铃"叫醒对应的 AI，AI 自己调用 `fetch_inbox` 取信。空闲的 AI 不轮询，也不花额度。

| 成员 | 门铃 | 由谁配置 |
|---|---|---|
| Claude 桌面版（Code 标签页） | 往 Claude 的消息套接字注入一条「[协作桥]」消息 | `ai-bridge setup` |
| Codex（ChatGPT 桌面版） | 桥运行 `codex queue` 往它的对话里排一条「[协作桥]」消息，Codex 空闲时几秒内开始新一轮；找不到 `codex` 命令或排队失败时，退回 Stop hook 停靠 | `ai-bridge setup`，再在 Codex 里信任一次 hook（hook 负责登记对话 ID） |
| 其他，或门铃失效时 | AI 循环调用 `wait_for_mail` | 无需配置 |

## 1. 安装（一次）

需要 Windows、Node.js 22.13 或更新版本，以及 Git。从 GitHub Release 安装：

```powershell
npm install -g https://github.com/vwow521-dotcom/Interaction-ai/releases/download/v0.13.0/ai-bridge-0.13.0.tgz
ai-bridge setup
ai-bridge doctor
```

也可以先从 [Releases](https://github.com/vwow521-dotcom/Interaction-ai/releases) 页面下载 `ai-bridge-<版本>.tgz`，再 `npm install -g <下载的文件>`。安装包里的 `dist/build-info.json` 记着它构建自哪个提交、是哪个通道（release），`doctor` 和面板顶栏都读它。

想用 main 分支上的开发版，可以克隆仓库后运行 `npm ci`、`node bin/ai-bridge.mjs update --channel main`。它会把 `main` 取到临时目录，构建、打包，最后才替换全局安装，前面任何一步失败旧版都还在。不要用 `npm install -g github:…`：npm 全局安装 git 包时构建拿不到依赖，会失败，而且会先删掉原来的安装。

`setup` 会做下面几件事，每改一个文件都会先在原位置备份（`*.bak-ai-bridge-<时间>`）：

- `~/.claude.json`：`bridge` 改为由 Claude 启动本机安装的转接程序 `bin/bridge-mcp.mjs`。
- `~/.codex/config.toml`：`[mcp_servers.bridge]` 改为同一个转接程序。转接程序由客户端自己启动，所以桥没启动时也能先拿到占位工具，桥一起来就自动换成真实工具，不用在意启动顺序。
- `~/.codex/hooks.json`：加入**用户级** Stop hook。它对所有项目生效，但只拦下调用过 bridge `join` 的对话；其他对话结束时 0.1 秒就放行，跟没装一样。
- 清理旧版留在各项目 `.codex/hooks.json` 里的 hook，避免和用户级 hook 重复。

然后：

1. 在 Codex 的 **Settings > Hooks**（或输入框旁的 **Review hooks**）里信任新的 Stop hook。`doctor` 会告诉你是否已信任。
2. Claude 和 Codex 都**新开对话**。已经开着的对话还在用旧配置。

## 2. 准备项目并启动桥

```powershell
ai-bridge init E:\某项目     # 第一次用这个项目时：生成 bridge.config.yaml；不是 git 仓库就初始化并做一次提交
ai-bridge start E:\某项目    # 启动桥，面板 http://127.0.0.1:7878/
```

- 数据存在 `<项目>/.bridge/`，不会被提交进 git。
- 若端口已被占用，`start` 会显示已有桥的项目路径（如果可读）并退出。Claude 和 Codex 的转接程序、Stop hook 以及 `doctor` 默认都连 `127.0.0.1:7878`（环境变量 `BRIDGE_URL` 可以改，但 `setup` 不会替你配置），所以要让 AI 加入的项目必须跑在 7878 上：先停掉旧的桥，再 `start` 你的项目，然后用 `ai-bridge doctor` 确认「运行中的桥」一节显示的是这个项目。`--port` 换端口只适合另开一个面板查看别的项目，AI 不会连到那里。
- 审批、提问、门铃没人应、确认超时时，会弹 Windows 通知。不想要通知，在 `bridge.config.yaml` 里设 `notify: { enabled: false }`。
- 重启桥只需关掉终端再 `ai-bridge start` 一次。Claude 由转接程序自动重连；正在停靠的 Codex 会在 90 秒内反复重连，不会被放走。
- 同一个 Claude 会话重启转接程序时，会按消息套接字恢复上次的身份和门铃。普通 MCP 连接因会话关闭而解绑时，下次工具调用会恢复身份并附上一条说明。面板「释放」或调用 `leave` 后，需要明确调用 `join` 才能再次加入。

## 3. 加入协作桥

已安装 `bridge` skill 时，Claude Code 输入 `/bridge`，Codex 输入 `$bridge` 或从 `/skills` 选择 `bridge`。两边的 skill 都由用户显式调用。Claude 桌面版 Code 标签页、Codex 桌面版的命令列表和触发行为待验证。 [Claude Code 技能](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill) [Codex 技能与调用策略](https://learn.chatgpt.com/docs/build-skills#optional-metadata)

客户端支持 MCP 提示词时，可以选择 bridge 的 `join` 或 `inbox`。Claude Code 可用 `/mcp__bridge__join` 或 `/mcp__bridge__inbox`，桌面版的显示情况待验证。`join` 根据客户端产品匹配配置中的成员。只有一个匹配时自动填身份，多个或零个匹配时请按候选明确指定。 [Claude Code MCP 提示词](https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands)

`ai-bridge setup` 配置两种客户端并安装 skill。`setup --refresh` 只更新已有的托管文件，保留用户主动移除的 MCP 配置。从 0.7 升级后若尚未安装 skill，可继续使用下面的提示词。需要同时配置两个客户端时可显式运行 `setup`。

Claude：

```
你是 AI 协作桥中的 claude。调用 bridge 的 join（agent_id = "claude"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

Codex：

```
你是 AI 协作桥中的 codex。调用 bridge 的 join（agent_id = "codex"），然后严格按它返回的 protocol 工作。交接单和进度汇报用中文。
```

`join` 会告诉 AI 它用的是哪种门铃、该怎么等信。门铃按 `bridge.config.yaml` 里成员的 `product` 自动选择（`doorbell: auto`）。Codex 依次用「Codex 队列消息 → Codex Stop hook → 轮询」，Claude 依次用「Claude 消息注入 → 轮询」。桥默认等 30 秒确认唤醒。Codex 队列门铃在成员最近 60 秒有工具活动时额外等 90 秒，可用 `BRIDGE_WAKE_TURN_EXTRA_SECONDS` 调整。到办公室打开成员详情可查看门铃顺序和会话绑定。

桥重启后，在 Codex 重新 join（或在原对话里结束一轮）之前，桥不会用队列消息叫醒它，免得叫醒你已经不用的旧对话。这期间给它的信会等着，太久没人取会提示你去叫醒。

**旧项目要改一行配置：** 0.4 及以前生成的 `bridge.config.yaml` 里写的是 `codex: { product: codex, doorbell: codex-hook }`，这样只会用 Stop hook。改成 `doorbell: auto` 才会用上队列消息。

Codex 第一次加入后，要等它结束一轮，hook 才能登记它的对话 ID；在这之前来的信会先排着，登记后立刻送达。

用队列消息时，Codex 每一轮都正常结束，你随时可以直接在它的对话里说话。只有退回 Stop hook 停靠时：你想直接跟它说话，先点停止再输入；也可以在面板上给它发消息。停靠满 10 分钟还没有信，它会回一句「待命」，然后重新停靠（心跳）。

## 4. 日常流程

打开本地面板（http://127.0.0.1:7878/）后进入主页。左边的工作区可以按会议、工作流和成员筛选。会议及其批准后生成的任务用同一个文件夹，直接发起的流水线单独成夹。底栏显示当前阶段和已过去的时间，详情侧栏显示成员、租约、共享笔记和动态。手机从底部进入主页、工作区、聊天和待处理。

1. 点「发起」选择「开会讨论」或「直接开始流水线」。开始后直接进入新文件夹。正在执行的工作流可从文件夹或底栏停止。
2. 工作区第一项和底栏的「待你处理」打开侧栏。可以在这里批准、打回、回答问题、处理投递异常，也能跳到原卡片。主页突出最优先的审批，文件夹的「交接」区优先显示待审批项。历史交接可翻页。
3. AI 用 `ask_human` 提问后可以继续工作。你在待处理侧栏或聊天里回答后，协作桥会以信件送达答复。
4. 在聊天底部选收件人或在正文 @ 成员，例如 `@codex` 或 `@所有人`。「回复」会引用原消息。输入框下方显示送达预期，消息按收件人显示回执。AI 用 `say` 回复。成员连续互相 @ 达到 `chat.max_agent_turns`（默认 6）后，等你说话才继续叫醒成员。Enter 发送，Shift+Enter 换行。同一标签页内刷新或切换视图会保留聊天、发起和待办草稿。
5. 办公室的工位可跳到当前任务，或在聊天中预选该成员。成员详情可查看门铃、绑定和送达异常，也能释放身份。顶栏搜索已加载的文件夹、任务、文件和成员，回车打开第一项。主题默认跟随系统，手动选择保存在浏览器中。旧面板可访问 `/v1` 和 `/classic`。
6. 打回时，你写的备注是「用户要求」，AI 必须做到。审查者的意见分为「阻塞问题」（必须修）和「观察」（可选）。阻塞问题由桥分配任务内编号（如 `T2-B3`），可以附复现命令、执行目录和期望结果；返工 AI 要逐条跑过复现命令，并在交接单的 `addressed` 里按编号说明怎么处理、跑了什么。复审时 AI 要按编号逐条回答「已修复」或「未修复」，漏答、重复或写错编号会被拒绝，错误里会列出缺的编号；上一轮没修好的问题会继续带到下一轮。第一次审查应一次列全，不要每轮再挤出一个新问题。交接卡按编号显示问题、复现命令和状态，复审卡显示「上一轮 N 项：已修复 a，未修复 b；新增 c」。
7. 交接卡上的提交信息：有提交时显示提交链接；没有提交时，灰色的「未提交：没有文件改动」「未提交：已关闭自动提交」只是说明，不是错误。红字才表示提交出了问题，只会出现在 0.13 之前的旧记录里；0.13 起提交失败不会生成交接，阶段保持进行中，AI 会收到 git 的报错。
8. 审批卡片上的「范围提示」是提醒你：有改动没写进交接单，或者某个阶段改了别的阶段负责的文件（例如编码阶段改了 PLAN.md）。只提示，不阻止。
9. 审查阶段即使没改文件也会生成一个空提交，`git log` 里能直接看到每一轮的审查结论。
10. 每个任务有一个不进 git 的共享目录 `.bridge/shared/<运行号>/<任务号>/`，实现方和审查方共用，临时脚本、样例和复现用到的文件都放在这里。任务结束、打回和桥重启都会保留；确认某个运行彻底结束、这些文件不需要留档后，手动删除 `.bridge/shared/<运行号>/` 即可（0.11 不自动清理）。

## 5. 开会：先讨论，再并行分派

目标比较大、想让各个 AI 先各自出方案时，点「发起」，选择「开会讨论」，输入议题和参会成员。在文件夹的「讨论」里对照当前轮发言，历史轮可展开看全文。当前轮卡片显示可用的操作。

1. **提案（第 1 轮）**：每个参会成员收到一封会议信，独立写出方案，可以附任务拆分草案。会议期间 AI 不改文件。
2. **互评**。发言齐了，面板会通知你。你可以写一句意见，点「再互评一轮」，每个人都会拿到上一轮所有人的发言和你的意见。至少一人发言后，可以确认跳过还没发言的成员。
3. **定稿**：点「请 X 定稿」，由主持人（默认 `agents` 里的第一个，可在 `meetings.facilitator` 配置）综合讨论，写出最终方案、关键决策和任务清单。任务清单的每一项包括负责人、审查人（可选）、依赖、文件范围（paths）。桥会检查任务清单：编号重复、负责人不存在、依赖成环、阶段依赖写错（见下文）都会被打回给 AI 自己改。定稿提交后，桥会按任务模板推算一份**并行预览**：任务分成几波、每个成员排了几个实现和审查，再给出提示，例如「只有 codex 负责实现，claude 只负责审查」「3 项任务必须按依赖逐个完成」「codex 名下的 T1、T3 可同时领取，因同一负责人而顺延」「T2 等 T1（src/mcp.ts）」。提示只供参考，不拦截定稿。审批卡和历史轮次显示的是同一份预览。
4. **批准**。文件夹「讨论」显示定稿和任务表，也可在「待你处理」侧栏批准。批准备注会写进每个任务。打回时可以写下希望主持人修改的内容。批准后会执行以下操作。
   - 会议纪要保存为 `doc/meetings/<日期>-m<会议号>-<短标题>.md` 并单独提交。目录可用 `meetings.dir` 配置。
   - 任务清单变成看板：依赖满足的任务立即开始，其余显示「等 T1」或「等 T1@implement」。每个任务按 `task_template` 走：负责人实现 → 审查人审查（需要你批准，打回则回到实现）。没有审查人的任务实现完就算完成。

会议信保留上一轮全文。较早轮次每人附一句摘录，每句最多 160 字。有已登记的会议纪要时，信中也会给出路径。

**依赖的两种写法**：

- `T1` 表示等 T1 整个任务完成，审查通过并经你批准。
- `T1@implement` 表示 T1 的实现一交接，下游就可以开工，不用等审查。

阶段名必须是上游实际会有的，例如 T1 没有审查人时不能写 `@review`。两边会同时进行，所以双方都要写 `paths`，而且不能重叠。同一个上游只写一项。

`T1@implement` 管的是整个下游任务什么时候开工：开工时下游记下当时依据的那份上游交接，之后的实现和审查都以它为基线，不会自动换成新交接。如果审查人打回了上游，你确认打回之后，已经开工、而且依赖的阶段受这次打回影响的下游（被打回的就是它引用的阶段，或者返工会回到它引用的那个阶段或更早的阶段。例如打回 T1 的审查、返工回到 implement，`T1@implement` 和 `T1@review` 的下游都会收到），会收到一封「上游返工」通知；它引用的那个阶段重新交接后，会再收到「上游变更」。上游其他阶段的交接不会触发通知。通知只是提醒，下游任务不会被打断或作废，改不改由负责人自己判断。还没开工的下游会继续等新的合格交接。下游的任务信和审查信里有 `upstream_state`（current、reworking、superseded、cancelled）和 `upstream_changes`。下游等你审批时，交接卡的「上游依赖」一栏会提示「依据的 T1@implement 正在返工 / 已有更新」，批不批由你决定。

任务信的 `dependencies` 按取信时的状态列出前置任务。带 `@` 的依赖还附 `based_on`，记下开工时依据的那份上游交接（交接号和提交）。`stage` 和 `stage_status` 表示当前阶段及其状态，`last_handoff_stage` 和 `commit` 表示最近一次交接的阶段和提交。缺少当前阶段或提交时，对应字段为空。

并行时的规则：

- **一个 AI 一次只做一个任务**。同时分到两个任务时，第二封任务信等它交完第一个再发。同时有待领取的实现和审查时，先发审查，因为审查耗时短，而且别人在等它。已经在做的阶段不会被打断。
- **文件租约**。任务开始时，桥按 paths 租下文件。两个任务的 paths 重叠时，后一个会显示「等文件租约」。AI 要改范围外的文件，可用 `reserve_paths` 申请，冲突时会通知占用者。详情侧栏显示持有人、路径和手动租约是否过期。
- **按任务提交**：任务有 `paths`、有文件租约或有并行任务时，交接提交本任务范围内或交接单声明的改动，并避开其他任务的租约。只有一个普通任务且没有路径范围和租约时，仍会提交工作区的全部改动。审查交接只提交 `files_changed` 声明的改动。未声明文件的审查仍可生成空提交来记录结论（`git.commit_reviews` 默认开启）。桥在每个任务开工时记录工作区里的未提交路径。范围提示会根据开工快照和活跃租约标出交接时留下的原有改动和并行任务改动。

## 6. 异常情况

| 面板 / 通知 | 含义 | 你要做的 |
|---|---|---|
| 通知「X 叫不醒」，信在排队 | X 的对话被关掉或断开了（Claude 桌面版会关掉闲置对话的进程），现在没有门铃能叫醒它 | 打开 X 的对话说一句「继续」。它的第一次工具调用会恢复身份、取走排队的信，门铃也会自动接回来 |
| 待办「叫不醒」/ 通知「已响铃但尚未取信」 | 门铃顺序里能用的都按过了，30 秒内对方没有调用任何工具、也没有取信 | 在对应对话里说「继续」。排查 Codex 时看 `.bridge/bridge-log.jsonl` 里的 `codex_queue`、`doorbell_ring`、`wake_timeout`，以及 `%TEMP%/ai-bridge/codex-stop-hook.jsonl` |
| 「排队中，等对方这一轮结束」 | 信已响铃，收件人仍在线处理桥上的任务或会议 | 等它结束本轮。桥会在这段时间保留已响铃状态 |
| 某封信"送不到"，通知"需要你叫醒 X" | 门铃按了 3 次（间隔 2 分钟）X 都没来取信，或者 X 当时没在等信 | 去 X 里说「继续」；会话没了就新开一个，重新粘贴启动提示词 |
| "确认超时" | AI 取走了需要确认的信，10 分钟没有确认 | 看看它是不是卡住了。AI 跑长命令（比如完整 smoke）前可以用 `report_progress` 带上 `busy_minutes`（1–60 分钟）。期间它**正在做的那个阶段**的任务信不报这个超时，办公室显示「正在执行长命令，预计 HH:mm 前」；过了这个时间，并且在一个确认时限（默认 10 分钟）内也没有调用桥的工具，才照常报。会议信和其他信件不受 `busy_minutes` 影响 |
| 门铃一栏显示红字错误 | Claude 消息注入失败，比如 Claude 更新后接口变了 | 信件会重新投递；一直失败的话，在 Claude 里说「改用 wait_for_mail 等信」 |
| AI 说"身份已被另一个会话占用" | 同一个身份开了两个会话，或旧会话还没超时 | 打开成员详情并点「释放身份」，再让新会话 join。也可以在新会话里说"用 takeover=true 重新 join"。它的回复里会写明旧会话空闲了多久、多久后自动释放 |
| 不确定配置对不对 | — | `ai-bridge doctor` |

升级 Claude 或 Codex 后，可用 `ai-bridge doctor --probe` 检查 Codex 队列命令的帮助、SQLite 表和会话记录格式，以及当前守护进程收到的 Claude 套接字报告。探针只读。待办中出现「格式可能变了」时，可用同一命令复核。待办和成员详情的「复制叫醒语」优先给相应产品的快捷命令，剪贴板不可用时可以手动复制选中的文字。

`doctor` 会显示已安装的 skill 和产品版本。未验证的产品版本仍可以使用原有门铃。安装版落后于最新 Release（main 通道的安装则是落后于 GitHub main）时，`doctor` 才提示更新。它的「运行中的桥」一节对照正在运行的守护进程和安装版，两者不一致时提示「停掉 ai-bridge 后重新 ai-bridge start」；面板顶栏也显示运行中的版本，如 `v0.13.0 · f4bc0cc`，从源码运行时显示「开发版」。

## 7. 卸载 / 重装

```powershell
ai-bridge uninstall          # 移除 setup 添加的全部配置，也会清理旧版的手动配置
npm uninstall -g ai-bridge
```

## 8. 更新

```powershell
ai-bridge doctor                  # 安装版和运行中的桥各是哪个版本，是否落后于最新 Release
ai-bridge update                  # 下载最新 GitHub Release → 核对安装包 → npm install -g → setup --refresh → doctor
ai-bridge update --channel main   # 临时目录取 GitHub main → npm ci → npm pack → npm install -g → setup --refresh → doctor
```

- release 通道（默认）在全局安装之前核对安装包里的包名、版本、`channel: release` 和提交号。没有 Release、找不到唯一的 `ai-bridge-<版本>.tgz`、下载失败或核对不通过时直接退出，旧安装不动，也不会自动改用 main。

- `setup --refresh` 只更新**已经存在**的 bridge 配置，不会新增。你有意删掉的客户端（比如不用 Codex 时删掉的 `[mcp_servers.bridge]`）不会被加回来。要新增客户端就运行一次 `ai-bridge setup`。
- 全局安装的路径不变，所以更新后客户端配置通常不用改，Codex 的 hook 也不用重新信任。新代码只对**新开的对话**生效。如果桥正在运行，要重新 `ai-bridge start`。
- 选项：`--channel release|main` 选通道，`--ref <分支|标签|提交>` 安装 main 通道上的指定版本（只写 `--ref` 时视为 main 通道，和 `--channel release` 一起写会报错），`--force` 在已经是最新时也重装，`--dry-run` 只显示会做什么。
- 运行前最好先关掉 Codex，否则 Codex 可能用它内存里的旧配置覆盖 `~/.codex/config.toml`。

在源码仓库里，`npm run reinstall` 会安装**本地工作区**的版本（打包 → 全局安装 → `setup --refresh` → doctor），开发时用，通道记为 dev。发布新版本由维护者运行 `node scripts/release.mjs`：先做预检（版本号与锁文件一致、CHANGELOG 有本版本小节、工作区干净），再跑 typecheck、build、smoke，打包并核对安装包，最后只打印 `gh release create …` 命令，由维护者自己执行。加 `--dry-run` 只做预检并列出会打包的文件。各项目的 `.bridge/` 数据和 `bridge.config.yaml` 不受影响。

## 9. 后台成员

把下面两个成员按需加入项目 `bridge.config.yaml` 的 `agents`，并根据实际安装位置调整 DeepSeek Harness 的路径。配置生效后，第一次有信时桥会启动后台进程。你依然可以从 Antigravity 窗口或 DeepSeek TUI 加入，前台正在轮询时由前台取信。

```yaml
agents:
  antigravity:
    product: antigravity
    doorbell: auto
    acp:
      mcp: stdio
      mode: accept-edits
      permissions: deny
  deepseek:
    product: deepseek-harness
    doorbell: auto
    acp:
      command: 'E:\Deepseek-Harness\DeepSeek Harness.exe'
      args: [--expose-internals, 'E:\Deepseek-Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js', --profile, acp]
      env: { ELECTRON_RUN_AS_NODE: '1' }
      mcp: http
      permissions: deny
```

- **启动**。Antigravity 默认找 `%LOCALAPPDATA%\agy\bin\agy.exe`，也会从 PATH 查找 `agy.exe`。DeepSeek Harness 请填写 exe 和 ACP 参数。桥展开命令和参数中的 `%变量名%`，默认在项目目录启动。配置 `acp.cwd` 可以指定另一个工作目录。
- **权限**。`permissions: deny` 是默认值：桥会在代理提交权限请求时自动选「拒绝一次」，代理没有提供该选项时以取消结束。这是**自动拒绝**，不是逐次让你确认；需要逐次确认时，请从前台（Antigravity 窗口或 DeepSeek TUI）加入该成员。
  - `permissions: allow` 会让桥自动批准代理提交的 ACP 权限请求，可能涉及执行 shell 命令和访问项目外的文件。桥不审查请求内容，只在代理给出的选项里按「允许一次 → 始终允许」的顺序选。实测 Antigravity 在 `accept-edits` 模式下读文件（`Get-Content`）和 `git diff` 仍会请求权限，这些请求都被自动放行。代理没有提供允许选项，或回合正在取消时，请求只能以取消结束。
  - 选到「始终允许」时，代理可能记住这个决定，之后不再询问。`cwd` 只决定进程的启动目录，不限制代理能访问哪些文件；它实际能做什么，还取决于代理自身的配置和本机账号权限。
  - 建议只在可信或可丢弃的项目里用 `allow`；不确定时保持 `deny`，并在成员详情的「最近权限决定」里查看被拒绝了什么。
- **观察和停止**。在「办公室」点成员详情，可查看后台状态、最近输出、权限决定和重试时间。「停止后台」会结束当前回合和进程，之后可点「重启后台」恢复。任务栏的「停止」会取消正在处理该任务的后台回合。
- **DeepSeek 账号**。内置 `acp` profile 默认走 `deepseek-official` API Key 路由。若使用已经登录的 Harness 账号，可以把本仓库的 [bridge.deepseek-acp.patch.yaml](../bridge.deepseek-acp.patch.yaml) 放到项目目录，并在 `args` 末尾追加 `--patch, bridge.deepseek-acp.patch.yaml`。这让该进程选择 `deepseek-account` 下的 `deepseek-flash`。 [DeepSeek 模型配置](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)
- **体检**。`ai-bridge doctor --project <目录>` 检查命令和安装版本。加 `--probe` 会读取 ACP 服务版本、会话能力和 HTTP MCP 支持，探针只发 `initialize`。
