# Codex Web 成套构建、预览与发布

此流程同时版本化 New API（网页与 Go API）、宿主 Runner 和个人环境 Worker 镜像。仅替换网页镜像不会更新 Runner 或 Worker。

## 构建环境

使用 `go.mod` 要求的 Go 版本、Bun、Node.js 24、Python 3、Docker，以及项目锁文件中的依赖。在 `web` 目录运行 `bun install --frozen-lockfile`。构建脚本默认使用公开 Debian 基础镜像和仓库内的 `codex-runner/Dockerfile.workspace`，不依赖维护者的私有镜像。

Worker 的 `runtime-vendor` 不进入版本库。安装所需版本的 Codex CLI 后，将已安装的 Linux x64 分发目录交给 `codex-runner/prepare-runtime-image.sh`；该脚本仅复制运行二进制，不复制 `.codex` 或登录凭据。另将已安装的 GitHub CLI 可执行文件放入 `codex-runner/runtime-vendor/gh`。其他架构需要调整构建目标及对应二进制。

```sh
bash codex-runner/prepare-runtime-image.sh /path/to/codex-linux-x64/vendor/x86_64-unknown-linux-musl
install -m 0755 /path/to/gh codex-runner/runtime-vendor/gh
python3 scripts/codex-release/build.py \
  --release trial-1 \
  --output /srv/new-api/releases/trial-1
```

输出目录应位于源码目录外且尚不存在。脚本冻结源码，构建 API 与 Worker 镜像，生成 Runner 归档、源码校验清单和 `release.json`。`--api-base-image` 可替换兼容的 Debian 基础镜像；`--worker-base-image` 可复用已验证兼容的 Worker 基础镜像。需要检查 Worker 根文件系统和数据布局兼容性，不能把镜像复用当作数据迁移。

## 独立预览

```sh
python3 scripts/codex-release/preview.py \
  --bundle /srv/new-api/releases/trial-1 --port 33010
```

预览使用新的 SQLite 实例，默认断开真实模型上游和生产 Runner。此步骤用于检查网页和 API 启动，不代替实际模型、GitHub 或 SSH 授权验收。

## 安装环境配置

以下配置通过环境变量传入；路径和 Compose project 必须对应自己的安装。配置文件与密钥存放在仓库外。默认值如下：

| 环境变量 | 默认值 |
| --- | --- |
| `CODEX_RELEASE_COMPOSE` | `/etc/new-api/compose.private.json` |
| `CODEX_RELEASE_PROJECT` | `new-api` |
| `CODEX_RELEASE_RUNNER` | `/opt/new-api-codex` |
| `CODEX_RELEASE_DATA` | `/var/lib/new-api-codex` |
| `CODEX_RELEASE_KEY` | `/etc/new-api-codex/runner.key` |
| `CODEX_RELEASE_RUNNER_URL` | `http://172.31.241.1:7310` |
| `CODEX_RELEASE_SERVICE` | `new-api-codex.service` |
| `CODEX_RELEASE_DROPIN` | `/etc/systemd/system/new-api-codex.service.d/90-codex-release.conf` |

示例：

```sh
export CODEX_RELEASE_COMPOSE=/etc/new-api/compose.private.json
export CODEX_RELEASE_PROJECT=new-api
python3 scripts/codex-release/deploy.py preflight \
  --bundle /srv/new-api/releases/trial-1
```

部署器面向已完成 Runner 与 Docker 网络初始化的安装。Compose 中的应用服务及容器名为 `new-api`；其余服务使用固定容器名，以便核对发布前后的状态。第一次安装还应配置 Runner 认证、Worker 镜像及网络；不要把发布脚本作为自动初始化生产环境的工具。

## 更新与回滚

备份应用数据库、Runner 配置、完整数据目录和运行版本，验证恢复流程后再安排维护窗口。发布前遍历所有用户和会话，等待运行任务、待审批及排队消息结束。

```sh
python3 scripts/codex-release/deploy.py apply \
  --bundle /srv/new-api/releases/trial-1
```

脚本关闭新任务入口后再次核对活动状态，再更新应用和 Runner；健康检查失败会按本次事务恢复程序配置。现有 Worker 的 RootFS 与挂载应满足兼容检查，否则需要另行安排迁移。

```sh
python3 scripts/codex-release/deploy.py rollback \
  --bundle /srv/new-api/releases/trial-1
```

回滚只使用对应发布包的事务记录，不覆盖后来产生的用户文件和会话。事务文件可能包含私有配置，应保存在仓库外。
