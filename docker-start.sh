#!/usr/bin/env bash
set -euo pipefail

# 进入 Linux 源码开发环境；拷贝项目时排除所有 node_modules。
# 容器内执行 pnpm install，再运行 pnpm run dev:web。
# 也可传入命令：bash docker-start.sh pnpm install
cd "$(dirname "${BASH_SOURCE[0]}")"
IMAGE="${DOCKER_DEV_IMAGE:-deepseek-harness-source-env}"
CONTAINER="${DOCKER_DEV_CONTAINER:-deepseek-harness-dev}"
command -v docker >/dev/null || { echo "请先在服务器安装 Docker。" >&2; exit 1; }
docker info >/dev/null

enter_container() {
  local exec_args=(-i --workdir /workspace)
  if [[ -t 0 && -t 1 ]]; then exec_args+=(-t); fi
  if [[ $# -eq 0 ]]; then set -- bash; fi
  docker exec "${exec_args[@]}" "$CONTAINER" "$@"
}

# 退出终端后容器继续运行；再次启动脚本复用原环境。
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  if [[ "$(docker container inspect --format '{{.State.Running}}' "$CONTAINER")" != true ]]; then
    docker start "$CONTAINER" >/dev/null
  fi
  enter_container "$@"
  exit 0
fi

# 本地没有开发环境镜像时才构建；源码通过挂载使用。
# BASE_IMAGE 可指定服务器能访问的仓库中的 Node 24 Debian Bookworm 镜像。
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [[ -z "${BASE_IMAGE:-}" ]]; then
    case "$(docker info --format '{{.Architecture}}')" in
      x86_64|amd64) BASE_IMAGE="swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:24.14.0-bookworm" ;;
      aarch64|arm64) BASE_IMAGE="swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:24-bookworm-linuxarm64" ;;
      *) echo "请通过 BASE_IMAGE 指定与服务器架构匹配的镜像。" >&2; exit 1 ;;
    esac
  fi
  docker build --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --build-arg "APT_MIRROR=${APT_MIRROR:-https://mirrors.aliyun.com}" \
    -t "$IMAGE" - < Dockerfile.source
fi
args=(-d --init --name "$CONTAINER" --restart unless-stopped
  --mount "type=bind,source=$PWD,target=/workspace"
  --mount "type=volume,source=deepseek-harness-node-modules,target=/workspace/node_modules"
  --mount "type=volume,source=deepseek-harness-home,target=/root"
  --workdir /workspace)
# Web 访问时指定 WEB_PORT，并配置应用监听 0.0.0.0。
if [[ -n "${WEB_PORT:-}" ]]; then args+=(-p "$WEB_PORT:$WEB_PORT"); fi

echo "源码位于 /workspace；容器内修改文件会同步到服务器源码目录。"
docker run "${args[@]}" "$IMAGE" sleep infinity >/dev/null
enter_container "$@"
