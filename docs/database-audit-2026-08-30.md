# Dashi Taskboard 数据与同步审计基线

审计时间：2026-08-30 21:00 CST 左右  
分支：`codex/wecom-taskboard`  
提交：`66c7005`  
结论：`NO-GO`，仅允许受控试运行，不允许执行 PostgreSQL 正式切换。

## 现场事实

- 腾讯云发布目录：`/opt/dashi-taskboard/releases/2026-08-30-perm-matrix`。
- Dashi、Nginx 和备份 timer 均为 active；本机 health 返回 `{"status":"ok"}`。
- SQLite `integrity_check=ok`、外键检查无输出，现场有 665 个任务、575 条 outbox 事件、2 个 Agent。
- PostgreSQL 16.14 接受连接。
- 腾讯云根分区约 40 GB，使用率 84%，剩余约 6.8 GB。
- Mini 与 MacBook Worker 均恢复心跳；2026-08-30 20:42 至 20:52 左右曾同时发生公网连接失败。
- 两台 Worker 的 `workspaceMap` 都只包含 `agent-acceptance`，没有真实 `dashi-taskboard` 项目。
- `DASHITASKBOA-2` 当前为 `todo`，Mini 和 MacBook 都曾因无工作区映射领取后拒绝执行。
- 全套测试 418/418 通过；TypeScript 检查和前端构建通过。

## NAS 备份纠错

“NAS 没有任何 Dashi 备份”是错误结论。精确路径：

`/share/CACHEDEV2_DATA/Backups/dashi-taskboard/tencent-cloud`

该目录存在多批 backup unit，最新已观察到：

`taskboard-2026-08-29T19-13-02-348Z.backup`

其中包含 `manifest.json` 和 `taskboard.sqlite`。腾讯云 `dashi-taskboard-backup.service` 同时显示 `Result=success`、`ExecMainStatus=0`。

仍未完成的灾备能力：标准 restore 命令、自动恢复演练、结构化 NAS 接收回执、持续 RPO/RTO 记录以及恢复后的真实业务链路验证。

## P0

1. `serviceExtraSecrets` 只验证密钥是否属于允许集合，不把密钥绑定到 `agent_id + device_id`；Basic 用户名仍由客户端自报。
2. Agent 注册可自行提交 `projects`，项目范围不是管理员控制的 ACL；权限检查也没有覆盖全部 MCP 读写工具。
3. 业务提交与 `integration_outbox` 插入不是同一数据库事务，宕机窗口可能造成业务已成功但事件永久缺失。
4. Worker MCP fetch 没有请求 timeout；现场双端连接故障后存在请求长期挂起风险。
5. 真实生产项目没有工作区映射，验收项目成功不能代表生产链路可用。

## 数据评级

评级不取平均，生产门槛要求 V/R/S/F 四项均至少为 3。

| 资产 | V | R | S | F | 说明 |
|---|---:|---:|---:|---:|---|
| Dashi SQLite | 2 | 2 | 1 | 2 | 结构有效且有备份，但 outbox 无事务/确认，生产工作区未接通 |
| NAS Dashi backup | 1 | 2 | 1 | 2 | 备份真实存在，缺恢复演练与接收回执 |
| PostgreSQL target | 1 | 1 | 0 | 1 | 实例健康，但 Dashi schema、迁移、备份、恢复均未实现 |
| vault-content | 1 | 1 | 0 | 1 | SQLite 可读，但 audit 为 `projection_mismatch`，不可进入 Dashi 关键路径 |
| file-governance | 1 | UNVERIFIED | UNVERIFIED | 2 | 多个 SQLite 完整性通过，恢复与同步证据不足 |

## 一次性 PostgreSQL 切换门禁

以下任一未满足即保持 `NO-GO`：

- 云盘使用率降到 80% 以下并保留 WAL、临时导入和双份备份空间。
- 完成 PostgreSQL 数据访问层、21 张表 schema 和 migration ledger。
- 完成空目标库强制门禁、逐表行数/主键/哈希/序列对账。
- 完成 PostgreSQL backup、restore、NAS receipt 和故障注入预演。
- 完成绑定式 Agent 凭据、服务端 ACL 和事务性 outbox。
- 完成双机真实项目映射、员工手机 WorkBuddy 与人工审批 E2E。

正式切换必须遵守 `docs/postgresql-one-shot-cutover.md`：一个维护窗口、一个权威源、上线点前可整体回滚、禁止长期双写。

## 证据限制

本基线记录了可重复检查的路径和状态，但没有包含任何密钥。未来 Claude/Codex 审计必须保存带时间戳的报告文件；聊天输出不能单独作为发布证据。
