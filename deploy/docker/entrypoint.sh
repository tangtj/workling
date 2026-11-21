#!/usr/bin/env bash
set -Eeuo pipefail

# 在线代码放在数据卷，避免重建容器丢失已经安装的版本。
APP_HOME=${APP_HOME:-/data/app}
IMAGE_ROOT=${IMAGE_ROOT:-/app}
STATE=${APP_HOME}/state.json
MAX_ATTEMPTS=3
# 这两个覆盖项仅供入口脚本测试；生产使用 /data 和固定的 serve 命令。
WORKLING_DATA=${WORKLING_DATA:-/data}
WORKLING_EXEC=${WORKLING_EXEC:-}
export APP_HOME IMAGE_ROOT STATE MAX_ATTEMPTS WORKLING_DATA
export WORKLING_APP_HOME=${APP_HOME} WORKLING_IMAGE_ROOT=${IMAGE_ROOT}

log() { printf '[entrypoint] %s\n' "$*" >&2; }
mkdir -p "${APP_HOME}/releases"

# JSON 与版本比较交给 Bun，路径经环境变量传递，不把外部内容拼进代码。
json() {
  ACTION=$1 bun -e '
try {
const fs = require("node:fs");
const path = require("node:path");
const { APP_HOME, IMAGE_ROOT, STATE, WORKLING_DATA, ACTION } = process.env;
const { compareVersions, VERSION_PATTERN, isEdge } = require(path.join(IMAGE_ROOT, "src/runtime/version.ts"));
const validVersion = v => typeof v === "string" && (v === "dev" || new RegExp(VERSION_PATTERN).test(v));
const readState = () => {
  if (!fs.existsSync(STATE)) return null;
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  if (!s || ![s.current, s.previous].every(v => v === null || validVersion(v)) ||
      typeof s.previousIsImage !== "boolean" || !(s.backup === null || typeof s.backup === "string") ||
      typeof s.pending !== "boolean" || !Number.isSafeInteger(s.attempts) || s.attempts < 0 || typeof s.updatedAt !== "string" ||
      Object.keys(s).some(k => !["current", "previous", "previousIsImage", "backup", "pending", "attempts", "updatedAt", "lastError", "lastSuccess", "image"].includes(k)) ||
      s.image !== undefined && !validVersion(s.image) ||
      s.lastError !== undefined && typeof s.lastError !== "string" ||
      s.lastSuccess !== undefined && (!s.lastSuccess || !validVersion(s.lastSuccess.tag) || typeof s.lastSuccess.at !== "string" ||
        Object.keys(s.lastSuccess).some(k => !["tag", "at"].includes(k))))
    throw new Error("更新状态文件格式无效");
  return s;
};
const write = s => {
  const temp = STATE + ".entrypoint.tmp";
  fs.writeFileSync(temp, JSON.stringify(s) + "\n", { mode: 0o600 });
  fs.renameSync(temp, STATE);
};
const restore = backup => {
  const root = fs.realpathSync(path.join(WORKLING_DATA, "backups"));
  if (typeof backup !== "string" || !path.resolve(backup).startsWith(path.resolve(WORKLING_DATA, "backups") + "/") ||
      !fs.realpathSync(backup).startsWith(root + "/") || !fs.statSync(backup).isFile()) throw new Error("数据库备份路径无效");
  // 服务未启动时恢复，防止运行中的 SQLite 连接与 WAL 污染恢复后的数据库。
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(path.join(WORKLING_DATA, "workling.db" + suffix), { force: true });
  fs.copyFileSync(backup, path.join(WORKLING_DATA, "workling.db"));
  fs.chmodSync(path.join(WORKLING_DATA, "workling.db"), 0o600);
};
const version = root => fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || "dev";
const newer = (a, b) => {
  if (!validVersion(a) || !validVersion(b)) throw new Error("版本号格式无效");
  return compareVersions(a, b) > 0;
};
const select = () => {
  const current = path.join(APP_HOME, "current");
  const image = version(IMAGE_ROOT);
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink() &&
      fs.existsSync(path.join(current, "src/cli.ts")) && fs.existsSync(path.join(current, "VERSION")) && (isEdge(version(current)) ? readState()?.image === image : newer(version(current), image))) return current;
  // 管理员拉了更新的镜像后，以镜像为准，清除旧在线版本的选择。
  if (fs.lstatSync(current, { throwIfNoEntry: false })) {
    fs.unlinkSync(current);
    const s = readState();
    if (s) {
      delete s.lastError;
      delete s.lastSuccess;
      write({ ...s, current: null, pending: false, attempts: 0, updatedAt: new Date().toISOString() });
    }
  }
  return IMAGE_ROOT;
};
if (ACTION === "select") {
  let selected = select();
  const s = readState();
  if (selected === path.join(APP_HOME, "current") && s?.pending) {
    s.attempts++;
    write(s);
    if (s.attempts > Number(process.env.MAX_ATTEMPTS)) {
      const target = s.previousIsImage ? null : path.join(APP_HOME, "releases", s.previous || "");
      if (!s.previous || target && (!fs.existsSync(path.join(target, "src/cli.ts")) || version(target) !== s.previous)) throw new Error("自动回滚的上一版本无效");
      if (s.backup) restore(s.backup);
      const current = path.join(APP_HOME, "current");
      if (target) {
        const temp = current + ".entrypoint.tmp";
        fs.rmSync(temp, { force: true });
        fs.symlinkSync(target, temp);
        fs.renameSync(temp, current);
      } else fs.unlinkSync(current);
      write({ ...s, current: s.previous, previous: null, backup: null, pending: false, attempts: 0,
        lastError: "新版本连续 3 次启动失败，已自动回滚", updatedAt: new Date().toISOString() });
      console.error("[entrypoint] 新版本连续 3 次启动失败，已自动回滚");
      selected = select();
    }
  }
  console.log(selected);
}
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
'
}

selected=$(json select)
# 容器重启后上一个服务进程已退出，清除其可能遗留的作业锁。
rm -f "${APP_HOME}/update.lock"
log "启动代码目录：${selected}"
cd "${selected}"
if [[ -n ${WORKLING_EXEC} ]]; then
  exec bash -c "${WORKLING_EXEC}"
fi
exec bun src/cli.ts serve
