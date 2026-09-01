# Dashi Taskboard PostgreSQL 一次性切换方案

## 决策

Dashi 从腾讯云单写 SQLite 一次性切换到腾讯云 PostgreSQL。准备和演练可以反复进行，但正式切换只允许一个维护窗口、一个权威源和一个上线决策；禁止长期双写。

目标使用现有健康的 PostgreSQL 16 集群，新建独立数据库 `dashi_taskboard` 和最小权限角色，不与 `wecom_ai` 共用业务表。附件文件继续保存在现有文件存储/NAS，PostgreSQL 只保存附件元数据。

## 当前硬门槛

- 腾讯云根分区当前约 40 GB，已使用 84%，剩余约 6.7 GB。切换前必须清理或扩容，使使用率低于 80%，并保留数据库、WAL、临时迁移文件和至少两份备份的空间。
- Mini 与 MacBook 的真实 `dashi-taskboard` 项目必须分别完成 `workspaceMap` 配置和一次真实执行。
- 设备凭据必须绑定 `agent_id + device_id`，项目授权必须由服务端管理员分配。
- 所有 Agent MCP 入口必须执行统一项目授权。
- 业务写入和 `integration_outbox` 必须成为同一 PostgreSQL 事务。
- PostgreSQL 备份、恢复、NAS 回执和 RPO/RTO 证据必须先在预演环境通过。

任一门槛未满足，正式切换为 `NO-GO`。

## 必须迁移的范围

当前 21 张业务表必须全部纳入清单和逐表对账：

1. `projects`
2. `project_members`
3. `project_messages`
4. `project_device_mappings`
5. `workflow_workspaces`
6. `tasks`
7. `task_relations`
8. `task_reviews`
9. `task_leases`
10. `comments`
11. `attachments`
12. `agents`
13. `agent_requests`
14. `integration_outbox`
15. `devices`
16. `codex_thread_mappings`
17. `ai_chat_threads`
18. `ai_chat_runs`
19. `ai_chat_events`
20. `wecom_oauth_states`
21. `wecom_sessions`

同时迁移并校准所有自增序列，尤其是 `integration_outbox.sequence` 和项目消息序列。JSON 字段必须进行解析验证后写入 `jsonb`，时间字段统一为 `timestamptz`，不得把非法旧值静默转成 `NULL`。

## 正式切换前的实现

1. 增加 PostgreSQL 数据访问实现和显式 schema migration 账本。应用通过单一配置选择 SQLite 或 PostgreSQL；这只是切换能力，不允许同时向两个后端写入。
2. 增加只读取 SQLite 一致性备份、只写入空 PostgreSQL 目标库的迁移工具。目标非空必须拒绝执行。
3. 迁移工具输出逐表行数、主键集合摘要、关键列规范化 SHA-256、最大序列、外键检查和拒绝记录；任何一项不一致即失败。
4. 增加标准 PostgreSQL `backup`、`restore`、`verify` 命令，并把恢复演练结果写成不可变 receipt 后同步 NAS。
5. 预演至少两次：一次正常迁移，一次故意注入失败并确认完整回滚。预演使用生产备份副本，不连接生产目标数据库。

## 单一维护窗口 Runbook

### 1. 冻结

- 暂停 WorkBuddy 写入入口并显示维护页。
- 停止 Mini、MacBook 的所有 Task Worker。
- 阻止新的 AI run、任务变更和附件上传。
- 等待在途请求结束。
- 门禁查询必须确认活动 `task_leases=0`、运行中 `ai_chat_runs=0`、pending 写请求为 0；不满足则中止。

### 2. 生成回滚基线

- 停止 Dashi 服务。
- 使用 SQLite online backup 生成数据库快照，并与附件目录组成同一 backup unit。
- 执行 `integrity_check`、`foreign_key_check`、附件存在性和 SHA-256 检查。
- 将该 backup unit 同步腾讯云备份目录和 NAS，取得双端哈希回执。
- 保存 Worker cursor/state 文件的哈希，但不得修改其 cursor。

### 3. 迁移

- 确认目标 `dashi_taskboard` 数据库为空且 schema migration 版本正确。
- 从冻结后的 SQLite backup unit 导入，而不是读取仍可能变化的活动文件。
- 在 PostgreSQL 单一事务或可完整丢弃的 staging database 中导入全部 21 张表。
- 校准 sequence，并运行约束、外键和数据类型检查。
- 生成逐表对账报告和整体 migration receipt。

### 4. 切换但暂不开放

- 仅修改腾讯云私有 EnvironmentFile，使 Dashi 指向 PostgreSQL；连接凭据不得进入 Git、命令行或日志。
- 启动 Dashi，保持外部维护页不撤销。
- 验证 `/health`、`/api/system/data-health`、项目列表、任务、评论、项目群聊、附件下载、Agent 列表和 outbox cursor。
- 使用专用验收项目完成一次“员工消息 → @Agent → 领取 → 执行 → 评论/群聊进度 → 提审 → 管理员批准”的双机链路。
- 验证 Mini Worker cursor 能从原 outbox sequence 继续消费，不重放已完成任务，也不漏掉新事件。

### 5. 上线点

只有以下证据全部通过才撤销维护页：

- 21 张表行数一致。
- 主键摘要和关键业务摘要一致。
- 外键、唯一约束、sequence 均通过。
- 附件元数据与文件逐项匹配。
- 双机 Agent 和手机 WorkBuddy 真实链路通过。
- PostgreSQL 备份与恢复演练 receipt 存在，NAS 哈希一致。
- 数据评级至少达到 `V3/R3/S3/F3`。

撤销维护页是本次切换的 point of no return。在此之前禁止员工写入，因此回滚不会丢失新业务数据。

### 6. 回滚

任一上线门禁失败：

- 停止 PostgreSQL 模式 Dashi。
- 丢弃失败的目标数据库或将其标记为 quarantined，不能继续作为权威源。
- 恢复原 SQLite 配置和冻结 backup unit。
- 启动 Dashi 和 Workers，验证 cursor、任务、群聊和附件。
- 撤销维护页并发布失败 receipt。

上线点之后不得直接切回旧 SQLite，因为旧库已经落后。此后若需要回退，必须执行一次完整的 PostgreSQL → SQLite 反向迁移和新的维护窗口，不能形成双写。

## 切换后的边界

- PostgreSQL 是 Dashi 任务、项目群聊、Agent、租约、审批和 outbox 的唯一权威源。
- `vault-content.sqlite` 仍是 Mini 单写的知识内容控制库；Dashi 通过异步 publication request/receipt 集成，OB 不在 Dashi 提交事务中。
- NAS 是附件和备份存储，不承担在线事务。
- SQLite 旧库只作为加密归档保留，标记 `retired/read-only`，禁止应用连接。
