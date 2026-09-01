审计报告已写入计划文件。以下为完整报告（这也是被调度脚本捕获的正式输出）：

---

# Dashi Taskboard 数据库 / 跨端同步 / 灾备独立审计报告

审计时间：2026-09-01（UTC+8）｜分支 codex/wecom-taskboard（本地 HEAD 66c7005）｜全部实测：腾讯云 / MacBook / NAS 只读直连 + 一次只读认证探针。**无证据缺口**（三端均可达；唯一未核验项：SERVICE_EXTRA_SECRETS 的分发持有者清单，因不读取密钥值）。

## A. 最严重问题

### P0-1 线上运行的是未提交代码，Git 不是线上事实源
- `/opt/dashi-taskboard/current` → `releases/2026-08-30-bound-agents`（"线上应为 perm-matrix"的说法已过时）。
- 线上 app.mjs / wecom-auth.mjs / task-worker.mjs 的 md5（d9ab665…/4c1cc2d…/ca52d40…）== Mini 本地**工作树**，≠ git HEAD（1f4fc6e…/51722e9…/9ef7282…）。
- 后果：绑定凭据安全修复只存在于一台 Mini 的未提交工作树和线上目录；任何"回滚到 git 历史"都会回退掉这些安全修复。

### P0-2 业务写入与 integration_outbox 非同一事务（实测确认）
- 派发路径：`createProjectMessage` 独立提交后 `appendIntegrationEvent` 是另一条语句（server/app.mjs:769）。
- 领取路径：`claimTask` 自带事务（server/database.mjs:1592-1630），outbox 写在事务外（server/app.mjs:2242-2248）。
- 崩溃窗口 = 数据已提交、事件永久丢失：@Agent 派发丢失 → Agent 永远收不到；workbuddy 事件丢失 → 下游永久漏同步且无对账发现。

### P0-3 切换磁盘硬门禁失败
- `/dev/vda1 40G，已用 81%，剩 7.7G`；docs/postgresql-one-shot-cutover.md:11 要求 <80%。

### P1-1 serviceExtraSecrets 不绑定身份（代码层属实；生产当前不可利用）
- server/wecom-auth.mjs:327-337：extra secret 只校验"属于集合"，用户名自报。test/auth-hardening.test.mjs:236-269 明示 device-a-secret 可注册为 codex-mini。
- **实测探针**（只读 dashi_list_agents）：Mini 密钥 + 用户名 codex-macbook/attacker → 302 拒绝；正确用户名 → 200。两台生产 Worker 用的是绑定凭据，当前不可冒充。
- 残留：线上 env 配置了 `CODEX_TASKBOARD_SERVICE_EXTRA_SECRETS`（key 已实测存在），该未绑定域持有者未知，一旦分发即重开冒充面。另：注册表 projects 为空 = 全局通行证（app.mjs:631），与绑定凭据"空=全拒"语义不对称。

### P1-2 Worker pending 无退避/上限/死信/告警
- scripts/task-worker.mjs:487-513：deferred/failed/aborted 永久滞留，每 10s 立即重试。双 Worker 争抢时非持有方每 10s 一次 LEASE_HELD 噪声；Runner 持续失败会形成"领取→失败→写评论→释放→再领取"热循环（353-368 行），评论无界增长。

### P1-3 备份链真实但无恢复能力
- 线上 scripts/ 实测**无 restore 脚本**；无恢复演练、无 RTO 记录、NAS 同步无哈希回执（sync-backups-to-nas.sh 仅 rsync 退出码）。
- 正面证据：备份 unit 质量高（online backup + integrity_check + foreign_key_check + 附件 sha 比对 + manifest）；每日 03:10 timer，backup.service Result=success；今日实测 NAS `/share/CACHEDEV2_DATA/Backups/dashi-taskboard/tencent-cloud/` 最新 unit 的 manifest sha256（245427ca…）**与腾讯云端完全一致**，该精确路径现存 7 个 unit。"NAS 无备份"确认为错误结论。

### P1-4 健康观测缺失
- `/health` 仅 `{"status":"ok"}`（server/app.mjs:1693-1696）。切换文档要求验证的 `/api/system/data-health` **在代码中不存在**（grep 无匹配）——切换验证步骤当前不可执行。

### P1-5 孤儿任务无人回收
- 实测：`DASHITASKBOA-1` 自 2026-08-08 起 in_progress、assignee=codex-agent，task_leases 全表 0 行——无租约"进行中"挂了三周多，无扫描无告警。

### P2
- `PRAGMA user_version = 0`（实测）；schema 演进为 database.mjs:538-713 临时 ALTER 链，无版本账本（#migrateTaskStatuses 1117-1185 有事务保护，是唯一亮点）。
- 生产项目双端已接通但只有只读实证：DASHITASKBOA-3 done（codex-mini）、-4 in_review（claude-macbook），均为 8-30 只读验收任务；-2 仍 todo。**写链路未实证**，验收成功不能外推。
- attachments 表 0 行：附件备份校验从未被真实数据执行过。
- MacBook Worker 8-31 16:43–23:19Z 连续 poll 失败；30s 请求超时已落地（旧 P0 已修复）。

## B. 资产评级矩阵（不取平均；门槛四项均 ≥3）

| 资产 | V | R | S | F | 依据（均实测） |
|---|---:|---:|---:|---:|---|
| Dashi SQLite（腾讯云主库） | 3 | 2 | 2 | 3 | V3：integrity/fk ok、manifest 计数==现网（667 任务/42 消息/21 项目）、Tencent↔NAS 哈希一致。R2：每日自动一致备份+异地，无恢复演练。S2：outbox 幂等游标+重放+游标回退检测，但写入非事务、无消费回执。F3：绑定凭据+审计身份+备份链集成；跨端写业务未实证 |
| Tencent PostgreSQL（作为 Dashi 目标） | 1 | 1 | 0 | 1 | 容器 postgres:16 healthy；实测库列表仅 postgres/template*/wecom_ai——dashi_taskboard 库、角色、schema、PG 数据访问层全部不存在 |
| vault-content（Mini 单写） | 1 | 1 | 0 | 1 | 实际路径 knowledge-engine/vault-content.sqlite（用户所给路径不存在）。dataflow-audit.json 2026-08-31T19:15Z：passed=false，projection_mismatch（5238 文档）。不得进入 Dashi 关键路径 |
| file-governance | 1 | UNVERIFIED | UNVERIFIED | 2 | file_governance.sqlite 2.3GB canonical；file_index 为 derived；quarantine 为 archive；NAS 侧为镜像。恢复与同步证据不足 |
| NAS Dashi backup | 3 | 2 | 1 | 3 | V3：今日与源端哈希对账一致。R2：是副本非恢复能力。S1：rsync 尽力复制无回执。F3：备份角色隔离清晰 |

## C. 对一次性切换方案的反驳与保留项

方案设计本身完备：21 表清单与 database.mjs 实表逐张核对一致；序列校准、jsonb 校验、空库门禁、双预演、单窗口、point of no return、禁双写均正确。保留项：

1. 引用了不存在的 `/api/system/data-health`（P1-4）。
2. "业务写入和 outbox 同事务"是未实现需求——SQLite 现状即不满足，PG 实现必须原生内建。
3. 磁盘门禁未过（P0-3）。
4. Worker cursor=609 必须对齐：迁移后 agents/workbuddy 两个 destination 的 sequence 须各自严格连续，否则触发游标回退→全量重放（幂等但产生接管/评论噪声）。
5. 回滚基线前提不成立：线上代码未入 git，"恢复原配置"无法定义——须先完成 P0-1。
6. 3 个 wecom_sessions 切换后失效→员工需重新打开应用，runbook 应预告。
7. attachments=0 时"附件逐项匹配"会以空集空转——须先制造真实附件验证。

## D. 最小可行修正（验收条件 + 回滚点）

**P0**
1. 固化线上代码：diff→提交→tag→重新部署。验收：线上 md5==git HEAD md5 且 git status clean。回滚点：纯提交无行为变化。
2. outbox 事务化：5 个写路径（claim/dispatch/release/submit/comment）的业务写与 appendIntegrationEvent 同 BEGIN IMMEDIATE。验收：kill -9 故障注入后 outbox 无缺口。回滚点：单 commit revert。
3. 磁盘 <80%：清理旧 release（留 current+前一个）或扩容。验收：df ≤80%。

**P1**
4. 移除或书面登记 SERVICE_EXTRA_SECRETS。验收：env 无该 key + 冒充探针被拒。
5. Worker pending 加 nextAttemptAt/指数退避/maxAttempts/DLQ/告警。验收：持续失败注入下评论数有界、item 落 DLQ。
6. restore 脚本 + NAS 哈希回执 + 一次真实恢复演练。验收：用最新 backup unit 在隔离目录恢复并通过 integrity/fk/附件校验，产出 receipt。
7. 处置 DASHITASKBOA-1 + 启动时孤儿 in_progress 扫描告警。
8. 实现 /api/system/data-health（DB 探测、备份时间、NAS receipt、worker 滞后、outbox 游标）或修正文档。

**P2**
9. user_version=1 + schema_migrations 账本表。
10. 附件真实"上传→备份→恢复→下载"验证。
11. anyAgent 双端争抢降噪（jitter 或服务端指派）。

## E. 明确回答

**一次性 PostgreSQL 切换：NO-GO。** 阻断门槛：① 磁盘 81%>80%；② PG 数据访问层/schema/migration 账本未实现且 dashi_taskboard 库实测不存在；③ 迁移对账工具未实现；④ PG backup/restore/NAS receipt/双预演未实现；⑤ outbox 事务性写入未实现；⑥ 线上代码未固化进 git；⑦ /api/system/data-health 不存在；⑧ 跨端写链路 E2E 未实证。已满足：绑定凭据（探针实测有效）、MCP 九工具统一项目授权、Tencent→NAS 备份哈希一致、单写 WAL。

**接入 OB：不适合。** pilot passed=false 未修复前不得接入；修复后也必须维持当前零耦合、严格异步 publication request/receipt。

**员工正式使用：可有限正式使用。** 主链路与手机 WorkBuddy 可用，但须明示：无恢复演练（R2）、outbox 崩溃窗口（小概率事件丢失）、无 data-health 监控。全员推广前至少完成 P0-1/2/3 与 P1-6。

## F. 给 Codex 的可执行 TODO

| # | actions | checks | evidence |
|---|---|---|---|
| 1 | 提交并部署 bound-agents 代码 | 三方 md5 一致；git status clean | md5 输出 + commit hash + readlink |
| 2 | 5 个写路径 outbox 同事务 | grep 全部调用点在事务内；kill -9 注入无缺口 | 注入前后 MAX(sequence) 与业务表对账记录 |
| 3 | 清理旧 release/扩容 | df ≤80% | df 输出 |
| 4 | 移除/登记 SERVICE_EXTRA_SECRETS | env key 清单；探针被拒 | key 清单 + 探针 HTTP 状态码 |
| 5 | worker 退避/DLQ/告警 | 持续失败注入：评论有界、落 DLQ | worker 日志 + state 文件 + 评论计数对比 |
| 6 | restore 脚本+回执+恢复演练 | 隔离恢复 integrity/fk/附件全过 | 演练 receipt（sha256/行数/时间戳）+ NAS 回执 |
| 7 | 处置 DASHITASKBOA-1+孤儿扫描 | 无租约 in_progress>24h 查询为空 | SQL 输出 + 告警日志 |
| 8 | 实现 data-health 端点 | 返回 DB/备份/NAS/worker/outbox 真实指标 | curl 输出 |
| 9 | user_version=1+migration 账本 | PRAGMA=1；账本首行 | sqlite 查询输出 |
| 10 | 附件真实链路验证 | 恢复后 sha==上传 sha | 两次 sha256 输出 |
| 11 | 双端写链路 E2E（真实改动→提审→批准） | 两端各 1 个 done 任务含评论/群聊/审批 | 任务 ID + DB 查询 + outbox 序列 |
| 12 | vault-content 修复前禁止 Dashi↔OB 耦合 | dataflow-audit passed=true | audit json 全文 |

—— 审计完。全部结论以实测为准；本报告不含任何密钥值。
