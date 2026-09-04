#!/bin/sh

set -eu

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
report_dir="${DASHI_AUDIT_REPORT_DIR:-$(pwd)/reports/database-audits}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
report_path="$report_dir/database-audit-$timestamp.md"
temporary_path="$report_path.partial"

mkdir -p "$report_dir"

run_audit() {
  "$CLAUDE_BIN" \
    --print \
    --permission-mode plan \
    --effort high \
    --output-format text \
    --add-dir /Volumes/ssd/Obsidian/toubiao \
    --add-dir /Volumes/ssd/file-governance
}

if run_audit >"$temporary_path" <<'CLAUDE_AUDIT_PROMPT'
你是 Dashi Taskboard 数据库、跨端同步和灾难恢复方案的独立审计员。只读检查并输出审计报告；不要修改文件、数据库、服务、配置或 Git 状态，不要部署。

当前工作目录是：
/Volumes/ssd/tianmac-home/Documents/技能管理及日常管理/dashi-taskboard

必须先自行核验，不能直接相信以下现状说明：
- 分支 codex/wecom-taskboard；以实际 HEAD、远端 current symlink 和前后端 SHA-256 为准，不得沿用旧 release 名。
- 腾讯云 Dashi 主库应为 /var/lib/dashi-taskboard/data/taskboard.sqlite；单写、WAL、每日备份并同步 NAS。
- 2026-09-04 从中央 API 观察到 codex-mini 与 claude-macbook 都在线且服务端绑定 dashi-taskboard；仍须分别核对本机 workspaceMap 与真实执行证据。
- 2026-09-04 腾讯云 Tailscale SSH 100.127.231.30:22 多次 5 秒超时；公网 WorkBuddy API 仍可访问。要分开记录 SSH 运维面与业务面健康。
- 主要业务写入已改为与 integration_outbox 同 SQLite 事务，且 SSE 在 commit 后发布；必须重新做故障注入，不得因为有提交就判定已修复。
- 已增加管理员专用 /api/system/data-health，预期现阶段为 V3/R2/S2/F2 且 productionReady=false；需验证线上而非只验证源码。
- Cloudflare D1/R2 是一条独立的精简协作实现，当前 schema 不包含项目群聊、成员、Agent、租约、审批和 outbox 等腾讯云完整模型；不得将 D1 测试通过当成本目标的替代验收。
- Tencent PostgreSQL 是既有企业微信等结构化业务域的重要事实库，但不是所有领域共用一套表。
- Mini 的 /Volumes/ssd/Obsidian/toubiao/vault-content.sqlite 是 OB 内容控制库，Mini 单写，Markdown 是投影；当前 pilot 审计可能未通过，不能进入 Dashi 核心可用链路。
- NAS 负责大文件和备份，不应成为在线事务数据库。
- Dashi NAS 备份的已知目标路径是 /share/CACHEDEV2_DATA/Backups/dashi-taskboard/tencent-cloud；必须检查该精确路径，不能用其他目录不存在推导“NAS 无备份”。
- /Volumes/ssd/file-governance 下有文件治理和知识图谱 SQLite，需要区分 canonical、derived、cache、mirror、archive。

必须检查这些文件与实际状态：
- AGENTS.md
- server/database.mjs
- server/app.mjs
- server/wecom-auth.mjs
- scripts/task-worker.mjs
- scripts/backup-local-data.mjs
- scripts/sync-backups-to-nas.sh
- docs/workbuddy-integration.md
- deploy/tencent/*
- deploy/tencent/deploy.sh
- docs/postgresql-one-shot-cutover.md
- /Volumes/ssd/Obsidian/toubiao/Codex/数据库优先同步设计.md
- /Volumes/ssd/Obsidian/toubiao/Codex/数据流治理规则.md
- /Volumes/ssd/Obsidian/toubiao/permanent-memory/environment/多端数据与Agent系统架构.md
- /Volumes/ssd/Obsidian/toubiao/permanent-memory/environment/企业微信数据同步审计.md

重点反驳并核验以下风险：
1. serviceExtraSecrets 是否真的与 device/agent 绑定，还是任意有效密钥仍可换用户名冒充另一个 Agent。
2. Agent 项目范围是否覆盖 get、claim、comment、project chat、renew、release、submit 等全部读写入口。
3. 全部业务变更与 integration_outbox 是否真的同事务，commit 失败、嵌套回滚和附件文件操作是否仍有半提交窗口。
4. Worker pending 是否有 nextAttemptAt、退避、最大重试、死信和告警；双 Worker 是否每 10 秒争抢造成噪声。
5. workspaceMap 是否覆盖真实生产项目；验收项目成功是否被错误外推为系统完成。
6. SQLite schema migration 是否有明确版本和失败回滚；PRAGMA user_version=0 是否影响可审计升级。
7. 备份是否存在可执行 restore 脚本、不可变恢复证据、RPO/RTO 记录和 NAS 同步回执。
8. /health 仍只是进程存活；/api/system/data-health 的完整性、外键、附件、outbox 与 V/R/S/F 证据是否真实，是否仍缺备份回执、消费者 ack/滞后与 Worker 健康。
9. vault-content pilot 当前不健康时，Dashi 是否仍可独立工作，知识发布是否严格异步。
10. 用户已经决定数据库切换必须一次完成。审计一次性 PostgreSQL 切换方案是否覆盖全部 21 张业务表、序列、附件元数据、身份、聊天、租约、outbox、备份、回滚点和真实跨端验收；禁止长期双写或两个权威源。
11. deploy/tencent/deploy.sh 是否确实发布当前 HEAD 的前后端产物、校验端口属主与重启稳定性，并在 Gate 3 失败时真正切回上一 release。

采用四轴评级，且不得求平均：
- V0-V4 数据有效性：未知 / 结构有效 / 语义有效 / 跨源对账 / 业务实证。
- R0-R4 可靠性：无保护 / 有备份 / 自动一致备份 / 恢复演练 / 故障切换演练。
- S0-S4 同步能力：未知 / 尽力复制 / 幂等游标 / 回执对账可重放 / 故障切换无丢重。
- F0-F4 环境适配：冲突 / 人工绕行 / 可隔离兼容 / 已集成审计身份备份 / 跨端业务实证。
生产门槛是四项都至少 3；没有证据的项目标记 UNVERIFIED，不得推测打高分。

输出顺序：
A. 最严重问题（P0/P1/P2，给出文件和行号或实测命令证据）
B. 当前资产评级矩阵（Dashi SQLite、Tencent PostgreSQL、vault-content、file-governance、NAS backup）
C. 对建议方案的反驳与保留项
D. 最小可行修正方案，分 P0、P1、P2，明确验收条件和回滚点
E. 明确回答：一次性 PostgreSQL 切换当前是 GO 还是 NO-GO；列出所有阻断门槛，以及是否适合接入 OB、是否适合让员工正式使用
F. 给 Codex 的可执行 TODO；每项包含 actions、checks、evidence，不允许用“测试通过”替代真实链路

如果无法安全读取腾讯云、MacBook 或 NAS，明确列为证据缺口，不要编造结果。
CLAUDE_AUDIT_PROMPT
then
  mv "$temporary_path" "$report_path"
  printf '%s\n' "Audit report: $report_path"
  cat "$report_path"
else
  status=$?
  failed_path="$report_path.failed"
  mv "$temporary_path" "$failed_path"
  printf '%s\n' "Audit failed; partial output: $failed_path" >&2
  exit "$status"
fi
