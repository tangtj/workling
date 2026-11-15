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
  DIR=${WORKLING_DIR:-/opt/workling}
  KEEP_BACKUPS=${WORKLING_KEEP_BACKUPS:-10}
  HEALTH_TIMEOUT=${WORKLING_HEALTH_TIMEOUT:-120}
  [[ $KEEP_BACKUPS =~ ^[1-9][0-9]*$ && $HEALTH_TIMEOUT =~ ^[1-9][0-9]*$ ]] || die "备份数量或健康检查超时无效"
  log "检查部署目录和命令"
  cd "$DIR"
  DIR=$PWD
  [[ -f docker-compose.yaml && -f .env ]] || die "部署目录必须包含 docker-compose.yaml 和 .env"
  for cmd in docker flock; do command -v "$cmd" >/dev/null || die "缺少命令：$cmd"; done
  docker compose version >/dev/null || die "Docker Compose 不可用"
  log "获取更新锁"
  exec 9>"$DIR/update.lock"
  flock -n 9 || die "已有更新在进行"
  prev=$(sed -n 's/^WORKLING_VERSION=//p' .env | tail -n 1)
  prev=${prev:-latest}
  # 兼容 Compose .env 的引号，不执行文件中的任何 shell 内容。
  prev=${prev%\"}; prev=${prev#\"}
  prev=${prev%\'}; prev=${prev#\'}
  [[ $prev =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || die "当前版本格式无效：$prev"
  log "拉取镜像：$tag"
  # 仅供本地镜像实测，避免尝试从远端拉取 local/* 镜像。
  if [[ ${WORKLING_SKIP_PULL:-0} == 1 ]]; then
    log "本地测试：跳过镜像拉取"
  else
    WORKLING_VERSION=$tag docker compose pull workling || die "镜像拉取失败，服务未变更"
  fi
  backup=''
  switched=0
  temp_env=''
  wait_healthy() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT)) container health
    while (( SECONDS < deadline )); do
      container=$(docker compose ps -q workling) || return 1
      health=''
      if [[ -n $container ]]; then
        health=$(docker inspect -f '{{.State.Health.Status}}' "$container") || return 1
      fi
      case $health in
        healthy) return 0 ;;
        unhealthy) return 1 ;;
      esac
      sleep 3
    done
    return 1
  }
  rollback() {
    local status=$? restored=1
    trap - ERR
    set +e
    [[ -z $temp_env ]] || rm -f "$temp_env"
    if (( ! switched )); then
      log "更新失败（退出码 ${status}），尚未切换，服务未变更"
      exit 1
    fi
    log "更新失败（退出码 ${status}），恢复上一版本配置"
    mv -f .env.prev .env || restored=0
    if [[ -n $backup ]]; then
      log "停止容器并恢复数据库备份：$backup"
      # 命名卷的宿主机路径不固定且需要 root，用旧镜像的临时容器恢复同一数据卷。
      if docker compose stop workling; then
        docker compose run --rm --no-deps -T --entrypoint sh -e "BACKUP=$backup" workling -c \
          'rm -f /data/workling.db-wal /data/workling.db-shm && cp "$BACKUP" /data/workling.db' || restored=0
      else
        restored=0
      fi
    fi
    log "重新启动旧版本并检查健康状态"
    if docker compose up -d && wait_healthy && (( restored )); then
      log "已回滚到 $prev"
    else
      log "回滚后仍未恢复，请人工处理"
    fi
    exit 1
  }
  trap rollback ERR
  running_container=$(docker compose ps --status running -q workling)
  if [[ -n $running_container ]]; then
    log "查询运行中的任务"
    if running=$(docker compose exec -T workling bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/data/workling.db", { readonly: true });
console.log(db.query("SELECT count(*) AS count FROM issues WHERE status = ?").get("running").count);
db.close();
'); then
      log "将中断 $running 个运行中的任务"
    else
      log "警告：无法查询运行中的任务数"
    fi
    log "备份数据库"
    backup_path="/data/backups/workling-$(date -u +%Y%m%dT%H%M%SZ)-$prev-$$.db"
    # 运行中的 SQLite 可能有 WAL，必须在容器内用 VACUUM INTO 做一致性备份。
    docker compose exec -T -e "BACKUP=$backup_path" workling bun -e '
import { mkdirSync, chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
mkdirSync("/data/backups", { recursive: true });
const db = new Database("/data/workling.db");
db.run("VACUUM INTO ?", [process.env.BACKUP]);
db.close();
chmodSync(process.env.BACKUP, 0o600);
'
    backup=$backup_path
    log "清理过期备份，仅保留最新 $KEEP_BACKUPS 份"
    docker compose exec -T -e "KEEP_BACKUPS=$KEEP_BACKUPS" workling sh -c '
      cd /data/backups && ls -1t workling-*.db | tail -n "+$((KEEP_BACKUPS + 1))" | while IFS= read -r old; do
        rm -f -- "$old" || exit 1
      done
    '
  else
    log "容器未运行（首次部署），跳过任务查询和数据库备份"
  fi
  log "保存配置并切换到 $tag"
  cp .env .env.prev
  chmod 600 .env.prev
  temp_env=$(mktemp "$DIR/.env.update.XXXXXX")
  awk -v tag="$tag" '
    /^WORKLING_VERSION=/ { if (!found++) print "WORKLING_VERSION=" tag; next }
    { print }
    END { if (!found) print "WORKLING_VERSION=" tag }
  ' .env > "$temp_env"
  chmod 600 "$temp_env"
  # mv 和 up 也可能部分成功后报错，因此在第一次修改生效配置前就启用回滚。
  switched=1
  mv -f "$temp_env" .env
  temp_env=''
  log "启动新版本容器"
  docker compose up -d --remove-orphans
  log "等待健康检查（最多 $HEALTH_TIMEOUT 秒）"
  wait_healthy
  trap - ERR
  log "已更新：$prev → $tag"
}

main "$@" </dev/null
