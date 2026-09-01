# WorkBuddy 项目同步

## 定位

WorkBuddy 项目是员工首选入口，Dashi Taskboard 是任务、权限、审批和共享项目消息的唯一事实源。WorkBuddy 不直接修改 Dashi 数据库，也不依赖客户端内部接口；项目自动化通过受认证的 MCP 连接器交换结构化事件。

Taskboard 内的“项目群聊”是可控的保底会话层：所有项目成员可见，每条消息保留员工或 Agent 身份，`@Agent` 会产生 `project.agent.requested` 事件。这避免把 WorkBuddy 客户端的私有实现当成共享会话保证。

## 数据流

1. Codex、DeepSeek Harness 或其他 Worker 更新 Dashi 任务。
2. Dashi 将任务、评论、附件和审批事件追加到 `integration_outbox`。
3. WorkBuddy 项目自动化调用 `dashi_project_changes`，使用返回的 `nextCursor` 增量读取。
4. 自动化用 Dashi `taskId` 作为外部唯一标识，更新 WorkBuddy 计划卡和动态摘要。
5. WorkBuddy Agent 用 `dashi_list_project_messages` 读取 `@Agent` 请求，用 `dashi_post_project_message` 把回复、进度和决策写回同一项目群聊。代员工转发时必须同时传 `authorUserId` 和 `authorName`；Agent 自己回复时不传，以保留真实作者。
5. 员工在 WorkBuddy 提交的进度通过 `dashi_add_comment` 写回；完成工作通过 `dashi_submit_for_review` 进入审核中。
6. 只有 Dashi 管理员能审批为完成；审批事件随后再次进入 WorkBuddy 增量流。

## MCP 配置

- URL：`https://workbuddy.lnhsjs.com/wecom/app/1000003/taskboard/mcp/workbuddy`
- 传输：Streamable HTTP / HTTP JSON-RPC
- 请求头：
  - `Authorization: Basic <base64(workbuddy-agent:CODEX_TASKBOARD_BRIDGE_SECRET)>`
  - `X-Taskboard-Client: workbuddy-bridge`
- Bridge 必须使用独立密钥域；不得复用 Worker Agent 凭据或 companion 凭据。密钥只放在 WorkBuddy 企业凭据管理和服务端密钥存储中，不写入项目资产、提示词或仓库。

服务提供四个工具：

- `dashi_project_changes`：按游标读取任务、评论和审批事件。
- `dashi_get_task`：读取任务当前状态和最近审批记录。
- `dashi_add_comment`：写入员工或 Agent 的进度摘要。
- `dashi_submit_for_review`：提交管理员审核，不能绕过审批直接完成。

## 项目自动化指令

建议每 1 分钟运行一次，并把游标保存在自动化自己的持久状态中：

1. 调用 `dashi_project_changes` 读取上次游标后的变化。
2. 按 `taskId` 查找或创建对应的 WorkBuddy 项目任务，禁止重复建卡。
3. 只更新标题、状态、负责人、阶段摘要、产物链接和审批结果；大附件保留在 NAS/Dashi，仅同步链接。
4. 在全部变化成功应用后保存 `nextCursor`；部分失败时保留旧游标重试。
5. 不响应由 `WorkBuddy Bridge` 自己产生的评论事件，避免循环。

## 当前边界

腾讯官方资料确认 WorkBuddy Enterprise Agent 可挂载 MCP/连接器和自动任务，但尚未确认项目看板提供公开 webhook 或双向任务 API。因此当前设计让 WorkBuddy 自动化主动调用 Dashi MCP；若以后出现官方项目 webhook，只替换传输层，不改变任务 ID、权限和审批模型。
