#!/bin/sh

set -eu

backup_dir="${CODEX_TASKBOARD_BACKUP_DIR:-/var/lib/dashi-taskboard/backups}"
nas_target="${CODEX_TASKBOARD_NAS_BACKUP_TARGET:-nas:/share/CACHEDEV2_DATA/Backups/dashi-taskboard/tencent-cloud/}"
ssh_config="${CODEX_TASKBOARD_SSH_CONFIG:-/var/lib/dashi-taskboard/.ssh/config}"

if [ ! -d "$backup_dir" ]; then
  echo "Backup directory does not exist: $backup_dir" >&2
  exit 66
fi

exec /usr/bin/rsync \
  --archive \
  --compress \
  --delete-delay \
  --partial \
  --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= \
  --rsh="/usr/bin/ssh -F $ssh_config -o BatchMode=yes -o ConnectTimeout=15" \
  "$backup_dir/" \
  "$nas_target"
