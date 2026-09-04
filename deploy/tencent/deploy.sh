#!/usr/bin/env bash
# 腾讯云 Dashi Taskboard 一次性部署脚本（带门禁）。
#
# 背景：2026-09-01 部署时反向隧道在重启空窗抢占 47823 端口，导致
# 腾讯云服务 EADDRINUSE 崩溃循环 59 次，公网流量打到 Mini 旧实例
# （假阳性 /health）。此脚本把部署固化为三道门禁：
#   Gate 1（部署前）：本地工作树干净 + 测试通过 + 远端 47823 端口属主检查
#   Gate 2（切换时）：远端确认无进程监听 47823 后才 systemctl restart
#   Gate 3（部署后）：端口属主 = 本机 node 进程 + /health + 前后端哈希对齐
# Gate 2 之后任一门禁失败都会把 current 切回旧发布并恢复服务。
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

SWITCHED=0
PREVIOUS_RELEASE=""

rollback_release() {
  [ "$SWITCHED" = "1" ] || return 0
  log "回滚 current 到 $PREVIOUS_RELEASE"
  ssh "$REMOTE" "
    set -e
    systemctl stop '$SERVICE' || true
    ln -sfn '$PREVIOUS_RELEASE' '$CURRENT_LINK'
    systemctl start '$SERVICE'
    curl -sf --retry 10 --retry-delay 1 'http://127.0.0.1:$PORT/health' >/dev/null
  " || printf '[deploy] CRITICAL: 自动回滚失败，请立即登录 %s 恢复 %s\n' "$REMOTE" "$PREVIOUS_RELEASE" >&2
  SWITCHED=0
}

rollback_on_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then rollback_release; fi
  exit "$status"
}
trap rollback_on_failure EXIT

# ---------- Gate 1a：本地 ----------
[ -z "$(git status --porcelain)" ] || die "工作树不干净，先提交再部署"
HEAD_SHA=$(git rev-parse HEAD)
log "HEAD = $HEAD_SHA"

if [ "${DASHI_DEPLOY_SKIP_TESTS:-0}" != "1" ]; then
  log "运行 npm run check（可用 DASHI_DEPLOY_SKIP_TESTS=1 跳过）"
  npm run check >/dev/null
fi
[ -f dist/web/index.html ] || die "本地前端产物 dist/web/index.html 不存在"

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

PREVIOUS_RELEASE=$(ssh "$REMOTE" "readlink -f '$CURRENT_LINK'")
[ -n "$PREVIOUS_RELEASE" ] || die "无法解析当前发布 $CURRENT_LINK"
ssh "$REMOTE" "mkdir -p '$RELEASE_DIR'"
git archive HEAD | ssh "$REMOTE" "tar -x -C '$RELEASE_DIR'"
# 前端必须使用 Gate 1 刚刚从当前 HEAD 构建的本地产物，不得复用旧发布。
ssh "$REMOTE" "mkdir -p '$RELEASE_DIR/dist'"
tar -C dist -cf - . | ssh "$REMOTE" "tar -xf - -C '$RELEASE_DIR/dist'"
ssh "$REMOTE" "
  set -e
  # node_modules 不入 git archive；当前发布已验证的依赖随新发布拷贝。
  cp -R '$PREVIOUS_RELEASE/node_modules' '$RELEASE_DIR/node_modules'
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
ssh "$REMOTE" "ln -sfn '$RELEASE_DIR' '$CURRENT_LINK'"
SWITCHED=1
ssh "$REMOTE" "systemctl start '$SERVICE'"

# ---------- Gate 3：部署后多源验证 ----------
log "Gate 3：多源验证（端口属主 + 进程稳定 + 前后端哈希 + /health）"
if ! VERIFY=$(ssh "$REMOTE" "
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
  # 3b. 服务 active，并在观察窗内没有新增重启。NRestarts 可包含历史值，不得绝对值误报。
  active=\$(systemctl is-active $SERVICE)
  [ \"\$active\" = active ] || exit 11
  restarts_before=\$(systemctl show $SERVICE -p NRestarts --value)
  sleep 3
  restarts_after=\$(systemctl show $SERVICE -p NRestarts --value)
  echo \"RESTARTS: \$restarts_before -> \$restarts_after\"
  [ \"\$restarts_before\" = \"\$restarts_after\" ] || exit 12
  [ \"\$(systemctl is-active $SERVICE)\" = active ] || exit 13
  # 3c. 运行后端与前端均必须对齐本次发布。
  server_sha=\$(sha256sum '$CURRENT_LINK/server/app.mjs' | cut -d' ' -f1)
  web_sha=\$(sha256sum '$CURRENT_LINK/dist/web/index.html' | cut -d' ' -f1)
  echo \"SERVER_SHA256: \$server_sha\"
  echo \"WEB_SHA256: \$web_sha\"
  # 3d. 健康检查
  health=\$(curl -sf "http://127.0.0.1:$PORT/health" || echo FAILED)
  echo \"HEALTH: \$health\"
  [ \"\$health\" != FAILED ] || exit 14
" ); then
  rollback_release
  die "Gate 3 验证失败：
$VERIFY"
fi
log "$VERIFY"

SERVER_SHA_LOCAL=$(shasum -a 256 server/app.mjs | cut -d' ' -f1)
SERVER_SHA_REMOTE=$(echo "$VERIFY" | awk '/^SERVER_SHA256:/ {print $2}')
WEB_SHA_LOCAL=$(shasum -a 256 dist/web/index.html | cut -d' ' -f1)
WEB_SHA_REMOTE=$(echo "$VERIFY" | awk '/^WEB_SHA256:/ {print $2}')
[ "$SERVER_SHA_LOCAL" = "$SERVER_SHA_REMOTE" ] || die "后端哈希不对齐：本地 $SERVER_SHA_LOCAL 远端 $SERVER_SHA_REMOTE"
[ "$WEB_SHA_LOCAL" = "$WEB_SHA_REMOTE" ] || die "前端哈希不对齐：本地 $WEB_SHA_LOCAL 远端 $WEB_SHA_REMOTE"

SWITCHED=0
trap - EXIT
log "部署成功：$RELEASE_NAME（端口属主=node，前后端哈希对齐，健康检查通过）"
