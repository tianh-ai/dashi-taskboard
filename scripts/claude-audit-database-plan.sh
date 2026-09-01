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
- 分支 codex/wecom-taskboard；线上腾讯云 release 当前应为 /opt/dashi-taskboard/releases/2026-08-30-perm-matrix。
- 腾讯云 Dashi 主库应为 /var/lib/dashi-taskboard/data/taskboard.sqlite；单写、WAL、每日备份并同步 NAS。
- Mini 与 MacBook 各有一个常驻 Worker；真实 dashi-taskboard 项目目前可能未配置 workspaceMap，验收项目成功不代表生产项目可执行。
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
- docs/postgresql-one-shot-cutover.md
- /Volumes/ssd/Obsidian/toubiao/Codex/数据库优先同步设计.md
- /Volumes/ssd/Obsidian/toubiao/Codex/数据流治理规则.md
- /Volumes/ssd/Obsidian/toubiao/permanent-memory/environment/多端数据与Agent系统架构.md
- /Volumes/ssd/Obsidian/toubiao/permanent-memory/environment/企业微信数据同步审计.md

重点反驳并核验以下风险：
1. serviceExtraSecrets 是否真的与 device/agent 绑定，还是任意有效密钥仍可换用户名冒充另一个 Agent。
2. Agent 项目范围是否覆盖 get、claim、comment、project chat、renew、release、submit 等全部读写入口。
3. 业务变更与 integration_outbox 是否同事务；宕机窗口会不会出现数据已提交但事件永久丢失。
4. Worker pending 是否有 nextAttemptAt、退避、最大重试、死信和告警；双 Worker 是否每 10 秒争抢造成噪声。
5. workspaceMap 是否覆盖真实生产项目；验收项目成功是否被错误外推为系统完成。
6. SQLite schema migration 是否有明确版本和失败回滚；PRAGMA user_version=0 是否影响可审计升级。
7. 备份是否存在可执行 restore 脚本、不可变恢复证据、RPO/RTO 记录和 NAS 同步回执。
8. /health 是否只是进程存活，是否缺少数据库、备份、同步滞后、Worker、outbox 健康指标。
9. vault-content pilot 当前不健康时，Dashi 是否仍可独立工作，知识发布是否严格异步。
10. 用户已经决定数据库切换必须一次完成。审计一次性 PostgreSQL 切换方案是否覆盖全部 21 张业务表、序列、附件元数据、身份、聊天、租约、outbox、备份、回滚点和真实跨端验收；禁止长期双写或两个权威源。

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
