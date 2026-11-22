// 服务端在 body 上标记部署方式（见 shell-html.ts）；Docker 部署里没有 workling 链接命令，
// 需要经 docker compose exec 进入容器，用镜像内的源码入口执行。
const docker = document.body.dataset.deploy === 'docker'

export function cliCommand(args: string) {
  return docker ? `docker compose exec workling bun src/cli.ts ${args}` : `workling ${args}`
}

export const startCommand = docker ? 'docker compose up -d' : 'bun run start'
