#!/usr/bin/env bash
# -E 让 ERR trap 继承到函数体，保证 main 中的错误也会触发回滚。
set -Eeuo pipefail

log() { printf '[update %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "$*"; exit 1; }

# bash -s 边读边执行；函数包装让 Bash 先读完整个脚本，子进程 stdin 固定为 /dev/null。
main() {
[[ $# -eq 1 ]] || die "用法：update.sh <tag>"
tag=$1
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "非法 tag：$tag"
APP_DIR=${WORKLING_DIR:-/opt/workling}
ENV_FILE=${WORKLING_ENV_FILE:-/etc/workling/workling.env}
SERVICE=${WORKLING_SERVICE:-workling}
KEEP_BACKUPS=${WORKLING_KEEP_BACKUPS:-10}
HEALTH_TIMEOUT=${WORKLING_HEALTH_TIMEOUT:-60}
log "读取服务配置"
if [[ -f $ENV_FILE ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
WORKLING_WORKSPACE=${WORKLING_WORKSPACE:-/var/lib/workling}
WORKLING_PORT=${WORKLING_PORT:-7420}
health_host=${WORKLING_HOST:-127.0.0.1}
if [[ -z $health_host || $health_host == 0.0.0.0 || $health_host == :: ]]; then
  health_host=127.0.0.1
elif [[ $health_host == *:* ]]; then
  health_host="[$health_host]"
fi
url="http://$health_host:$WORKLING_PORT/health"
[[ $KEEP_BACKUPS =~ ^[1-9][0-9]*$ && $HEALTH_TIMEOUT =~ ^[0-9]+$ ]] || die "备份数量或健康检查超时无效"
log "获取更新锁"
exec 9>"$WORKLING_WORKSPACE/update.lock"
flock -n 9 || die "已有更新在进行"
log "检查命令和工作副本"
for cmd in git bun curl; do command -v "$cmd" >/dev/null || die "缺少命令：$cmd"; done
cd "$APP_DIR"
[[ -z $(git status --porcelain) ]] || die "工作副本有本地改动，拒绝更新"
prev=$(git rev-parse HEAD)
log "获取远程标签"
git fetch --tags --force origin
target=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}") || die "标签不存在：$tag"
[[ $target != "$prev" ]] || log "已是 ${tag}，仍继续重启以应用"
backup=''
rebuilt_image=0
restarted=0
task_image=''
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 3 "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
rollback() {
  local status=$?
  trap - ERR
  set +e
  log "更新失败（退出码 ${status}），开始回滚"
  if (( restarted )); then
    log "停止服务"
    sudo -n systemctl stop "$SERVICE" || log "警告：停止服务失败"
    log "恢复代码和依赖"
    git checkout --detach --quiet "$prev" && bun install --frozen-lockfile --ignore-scripts --production || log "警告：恢复代码或依赖失败"
    if [[ -n $backup ]]; then
      log "恢复数据库备份"
      rm -f "$WORKLING_WORKSPACE/workling.db-wal" "$WORKLING_WORKSPACE/workling.db-shm"
      cp "$backup" "$WORKLING_WORKSPACE/workling.db" && chmod 600 "$WORKLING_WORKSPACE/workling.db" || log "警告：恢复数据库失败"
    fi
    if (( rebuilt_image )); then
      log "恢复任务镜像"
      docker build -t "$task_image" "$APP_DIR" || log "警告：恢复任务镜像失败"
    fi
    log "启动服务并检查健康状态"
    if sudo -n systemctl start "$SERVICE" && wait_healthy; then
      log "已回滚到 ${prev:0:12}"
    else
      log "回滚后服务仍未恢复，请人工处理"
    fi
  else
    log "恢复代码和依赖"
    git checkout --detach --quiet "$prev" && bun install --frozen-lockfile --ignore-scripts --production || log "警告：恢复代码或依赖失败"
    if (( rebuilt_image )); then
      log "恢复任务镜像"
      docker build -t "$task_image" "$APP_DIR" || log "警告：恢复任务镜像失败"
    fi
    log "失败发生在重启前，服务未受影响，已恢复代码"
  fi
  exit 1
}
log "切换到 $tag"
# checkout 可能部分执行后失败，因此在执行前启用回滚。
trap rollback ERR
git checkout --detach --quiet "$tag"
log "安装生产依赖"
bun install --frozen-lockfile --ignore-scripts --production
log "读取执行器设置"
settings=$(WORKLING_DB_PATH="$WORKLING_WORKSPACE/workling.db" bun -e '
import { Database } from "bun:sqlite";
try {
  const db = new Database(process.env.WORKLING_DB_PATH, { readonly: true });
  const row = db.query("SELECT sandbox, task_image FROM executor_settings WHERE id = 1").get();
  if (row) console.log(`${row.sandbox}\t${row.task_image}`);
  db.close();
} catch {}
')
IFS=$'\t' read -r sandbox task_image <<< "$settings"
if [[ $sandbox == docker ]]; then
  log "构建任务镜像"
  command -v docker >/dev/null || { log "缺少命令：docker"; false; }
  docker build -t "$task_image" "$APP_DIR"
  rebuilt_image=1
else
  log "执行器为本机进程，跳过镜像构建"
fi
# 尽量靠近重启备份，缩短回滚时可能丢失的数据窗口；运行中的 WAL 数据需用 VACUUM INTO 一致性备份。
log "备份数据库"
mkdir -p "$WORKLING_WORKSPACE/backups"
if [[ -f $WORKLING_WORKSPACE/workling.db ]]; then
  backup_path="$WORKLING_WORKSPACE/backups/workling-$(date -u +%Y%m%dT%H%M%SZ)-${prev:0:12}.db"
  WORKLING_DB_PATH="$WORKLING_WORKSPACE/workling.db" WORKLING_BACKUP_PATH="$backup_path" bun -e '
import { Database } from "bun:sqlite";
const db = new Database(process.env.WORKLING_DB_PATH);
const path = process.env.WORKLING_BACKUP_PATH.replaceAll("\u0027", "\u0027\u0027");
db.run(`VACUUM INTO '\''${path}'\''`);
db.close();
'
  backup=$backup_path
  chmod 600 "$backup"
  log "清理过期备份"
  find "$WORKLING_WORKSPACE/backups" -maxdepth 1 -type f -name 'workling-*.db' -print0 | xargs -0 -r ls -t | tail -n "+$((KEEP_BACKUPS + 1))" | while IFS= read -r old; do rm -f -- "$old"; done
else
  log "数据库不存在，跳过备份"
fi
log "重启服务"
restarted=1
sudo -n systemctl restart "$SERVICE"
log "等待健康检查"
if ! wait_healthy; then
  log "健康检查超时"
  false
fi
trap - ERR
log "已更新：${prev:0:12} → ${tag}（${target:0:12}）"
}

main "$@" </dev/null
