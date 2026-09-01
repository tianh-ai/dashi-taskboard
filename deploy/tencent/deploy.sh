#!/usr/bin/env bash
# 腾讯云 Dashi Taskboard 一次性部署脚本（带门禁）。
#
# 背景：2026-09-01 部署时反向隧道在重启空窗抢占 47823 端口，导致
# 腾讯云服务 EADDRINUSE 崩溃循环 59 次，公网流量打到 Mini 旧实例
# （假阳性 /health）。此脚本把部署固化为三道门禁：
#   Gate 1（部署前）：本地工作树干净 + 测试通过 + 远端 47823 端口属主检查
#   Gate 2（切换时）：远端确认无进程监听 47823 后才 systemctl restart
#   Gate 3（部署后）：端口属主 = 本机 node 进程 + /health + md5 对齐 git
# 任一门禁失败立即退出，不做任何"看起来成功"的假设。
#
# 用法（在 Mini 仓库根目录）：bash deploy/tencent/deploy.sh
set -euo pipefail

REMOTE="${DASHI_DEPLOY_HOST:-tencent}"
PORT=47823
SERVICE=dashi-taskboard
RELEASE_ROOT=/opt/dashi-taskboard/releases
CURRENT_LINK=/opt/dashi-taskboard/current
DATA_DIR=/var/lib/dashi-taskboard/data

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] FAIL: %s\n' "$*" >&2; exit 1; }

# ---------- Gate 1a：本地 ----------
[ -z "$(git status --porcelain)" ] || die "工作树不干净，先提交再部署"
HEAD_SHA=$(git rev-parse HEAD)
log "HEAD = $HEAD_SHA"

if [ "${DASHI_DEPLOY_SKIP_TESTS:-0}" != "1" ]; then
  log "运行 npm run check（可用 DASHI_DEPLOY_SKIP_TESTS=1 跳过）"
  npm run check >/dev/null
fi

# ---------- Gate 1b：远端端口现状 ----------
log "检查远端 $PORT 端口现状（重启前基线）"
PORT_STATE=$(ssh "$REMOTE" "ss -ltnp | grep ':$PORT ' || true")
if [ -n "$PORT_STATE" ]; then
  log "当前 $PORT 属主：$PORT_STATE"
  # 端口被占用不一定是问题（正常时是本服务自己），但必须能识别属主。
  echo "$PORT_STATE" | grep -q "pid=" \
    || die "端口被未知进程占用且无法识别属主，中止（可能是隧道/代理）"
fi

# ---------- 发布 ----------
STAMP=$(date -u +%Y-%m-%d-%H%M%S)
RELEASE_NAME="$STAMP-$(echo "$HEAD_SHA" | cut -c1-7)"
RELEASE_DIR="$RELEASE_ROOT/$RELEASE_NAME"
log "创建发布目录 $RELEASE_DIR"

ssh "$REMOTE" "mkdir -p '$RELEASE_DIR'"
git archive HEAD | ssh "$REMOTE" "tar -x -C '$RELEASE_DIR'"
ssh "$REMOTE" "
  set -e
  current=\$(readlink -f $CURRENT_LINK)
  # 依赖与前端产物随发布目录拷贝（node_modules 不入 git archive）
  cp -R \"\$current/dist\" '$RELEASE_DIR/dist'
  cp -R \"\$current/node_modules\" '$RELEASE_DIR/node_modules'
  chown -R $SERVICE:$SERVICE '$RELEASE_DIR'
"

# ---------- Gate 2：重启前确认无抢端口者 ----------
log "Gate 2：重启前确认 47823 无监听者（服务已停，隧道不得趁虚而入）"
ssh "$REMOTE" "systemctl stop $SERVICE"
sleep 1
LEASED=$(ssh "$REMOTE" "ss -ltnp | grep ':$PORT ' || true")
if [ -n "$LEASED" ]; then
  ssh "$REMOTE" "systemctl start $SERVICE" || true
  die "服务停止后 $PORT 仍被占用：$LEASED —— 存在抢端口者（隧道/代理），中止并回滚启动旧服务"
fi
log "端口干净，切换 symlink 并重启"
ssh "$REMOTE" "ln -sfn '$RELEASE_DIR' $CURRENT_LINK && systemctl start $SERVICE"

# ---------- Gate 3：部署后多源验证 ----------
log "Gate 3：多源验证（端口属主 + 进程 + md5 + /health）"
VERIFY=$(ssh "$REMOTE" "
  set -o pipefail
  # 3a. 轮询等待端口就绪（最多 15s），属主必须是本机 node 进程
  owner=''
  for i in \$(seq 1 15); do
    owner=\$(ss -ltnp | grep ':$PORT ' || true)
    echo \"\$owner\" | grep -q 'node' && break
    sleep 1
  done
  echo \"PORT_OWNER: \$owner\"
  echo \"\$owner\" | grep -q 'node' || exit 10
  # 3b. 服务 active 且无重启循环
  active=\$(systemctl is-active $SERVICE)
  [ \"\$active\" = active ] || exit 11
  restarts=\$(systemctl show $SERVICE -p NRestarts --value)
  echo \"RESTARTS: \$restarts\"
  [ \"\$restarts\" -lt 3 ] || exit 12
  # 3c. 运行代码 md5 对齐本发布
  md5_remote=\$(md5sum $CURRENT_LINK/server/app.mjs | cut -d' ' -f1)
  echo \"REMOTE_MD5: \$md5_remote\"
  # 3d. 健康检查
  health=\$(curl -sf "http://127.0.0.1:$PORT/health" || echo FAILED)
  echo \"HEALTH: \$health\"
  [ \"\$health\" != FAILED ] || exit 14
" ) || die "Gate 3 验证失败（退出码 $?）：
$VERIFY"
log "$VERIFY"

MD5_LOCAL=$(md5sum server/app.mjs | cut -d' ' -f1)
MD5_REMOTE=$(echo "$VERIFY" | grep REMOTE_MD5 | cut -d' ' -f2)
[ "$MD5_LOCAL" = "$MD5_REMOTE" ] || die "md5 不对齐 git HEAD：本地 $MD5_LOCAL 远端 $MD5_REMOTE"

RESTARTS=$(echo "$VERIFY" | grep RESTARTS | cut -d' ' -f2)
[ "$RESTARTS" -lt 3 ] || die "重启次数 $RESTARTS 异常，疑似崩溃循环，检查 journalctl -u $SERVICE"

log "部署成功：$RELEASE_NAME（端口属主=node，md5 对齐，健康检查通过）"
