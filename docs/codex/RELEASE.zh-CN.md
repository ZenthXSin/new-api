# Codex Web 成套构建、预览与发布

此流程同时版本化 new-api（内嵌网页与 Go API）、宿主 Codex runner，以及含 Python helper 的 worker 镜像。仅替换网页镜像无法更新 runner；仅替换宿主 Python 文件也无法更新已经构建的 worker 镜像。

## 当前生产与备份

2026-10-10 基线：正式 new-api 位于 `127.0.0.1:3000`，已部署在线版 `new-api:codex-web-20261010-online-v1`。后续版本以对应发布目录的 manifest、事务记录及线上镜像 ID 为准。Compose project 是 `new-api`，实际文件是 `/etc/new-api/production-compose.private.json`。该文件含其他六个正式服务与秘密，禁止输出内容或加入版本库。

Runner 是 `new-api-codex.service`，程序目录 `/opt/new-api-codex`，配置 `/etc/new-api-codex`，数据 `/var/lib/new-api-codex`。在线版已有用户个人 worker 容器。每次发布必须通过 live runner 遍历所有 owner 的每个会话，重新验证没有活动任务、待审批和排队消息；任何一次检查都只代表当时状态。

现有完整备份及私有清单位于 `/srv/new-api/deployment/`。七个归档的实际长度及 SHA-256 已与清单逐个重算匹配；此前的压缩流完整性及代表性文件提取检查通过。它们不等同于完整灾难恢复演练。

## 冻结与构建

等待所有代码修改及必要验证完成后，在项目根目录执行：

```sh
. /srv/new-api/tools/env.sh
python3 scripts/codex-release/build.py \
  --release 20261010-rc1 \
  --output /srv/new-api/releases/20261010-rc1
```

输出目录必须尚不存在且位于源目录之外。脚本首先复制源代码快照，再在快照构建网页和 Go binary，创建同版本的 API/worker 镜像及 `runner.tar.gz`。`release.json` 固定镜像 ID、runner checksum、binary checksum 和源文件清单 checksum。发布时校验成套制品，任一镜像 tag 被覆盖或 runner 文件改变均拒绝执行。宿主 Node binary 沿用正式 runner 的现有版本。

`source/` 是此次构建的可审阅快照；`source-sha256.json` 为源文件 SHA-256 清单。此脚本负责可复查构建，不声称不同时间/不同工具链构建具有逐字节可重复性。发布包路径在发布后仍被 systemd 用来读取不含秘密的 worker 镜像 ID，不能移动或删除。

## 隔离预览

```sh
python3 scripts/codex-release/preview.py start \
  --bundle /srv/new-api/releases/20261010-rc1 --port 33010
```

预览只监听 `127.0.0.1:33010`，使用独立 SQLite、随机会话密钥、internal Docker network、独立数据目录。不会挂载生产数据库、runner key、用户工程或 Docker socket。首次启动显示独立实例初始化页面，可用于验收真实构建产物及认证流程；真实模型、生产任务、GitHub 或 worker 功能需要另行隔离验收，不能用此预览健康检查替代。

停止仅删除本包带固定标签的候选容器与其网络；保留预览数据：

```sh
python3 scripts/codex-release/preview.py stop \
  --bundle /srv/new-api/releases/20261010-rc1
```

## 只读发布预检

```sh
python3 scripts/codex-release/deploy.py preflight \
  --bundle /srv/new-api/releases/20261010-rc1
```

未指定 action 时也默认 preflight。它检查真实 Compose 身份与当前镜像一致、runner 运行、API 健康、候选完整性，并从 live runner 查询每位 owner 的每个会话。任何活动任务、审批、排队消息（包括暂停的队列）都会拒绝发布。已有个人 worker 仅在只读根文件系统且镜像 RootFS 层与候选镜像完全一致时允许保留；不同的 helper 或 runtime 层会阻止发布，需要另行安排迁移。脚本不会删除用户环境。

## 正式发布事务

以下命令会短暂停止正式 API 和 runner，仅在正式发布已获授权时执行。具体是否已执行，以本包的事务记录为准。

```sh
python3 scripts/codex-release/deploy.py apply \
  --bundle /srv/new-api/releases/20261010-rc1
```

事务步骤：

1. 再次预检并锁定本机发布；保存 Compose 私有副本、原 systemd release override 和其他六服务容器身份。
2. 复制并准备新 runner，保留原 Node/runtime 文件；新版本代码会替换旧模块，移除已不在成套交付中的 `.mjs/.py/.sh`。
3. 仅停止 new-api 容器，关闭新任务入口；此时 runner 仍运行，再查询所有会话，若刚到达新任务则立即恢复 API 并中止发布。
4. 停止 runner，将旧程序目录原子移动为同盘版本备份，启用新程序目录。用户数据与 `/etc/new-api-codex` 原配置不变。一个专用 systemd drop-in 指向成套 worker image ID。
5. 仅修改实际 Compose 的 `new-api.image`；执行 `docker compose ... up -d --no-deps --pull never new-api`。不执行 `compose down`，不创建或更新其他六服务。
6. 等待 API 与 runner 健康，验证 API 使用指定 image ID，核对其他六服务的 container ID、image ID 和启动时间。保存私有事务记录。

runner 切换后的异常会自动恢复旧程序目录、原 Compose 与原 drop-in，重启 runner/API 后验证健康。该回滚保留当前用户内容、任务历史、数据库，不把整库备份覆盖回线上。捕获到的执行错误有自动回滚；主机掉电或强制 kill 后，应依据 `transaction/record.private.json` 与目录状态人工恢复，不能假设未完成的事务已自动撤销。

## 显式回滚

```sh
python3 scripts/codex-release/deploy.py rollback \
  --bundle /srv/new-api/releases/20261010-rc1
```

回滚前检查当前 API 仍是此版本、Compose 未被他人修改、没有活动/排队任务，再关闭入口复核并恢复程序配置。如果服务已被另一版本更新，拒绝盲目回退。保留失败版 runner 目录供分析，禁止自动删除用户数据。涉及新旧状态格式或数据库 schema 的不兼容改动，应先独立验证兼容性；代码回滚本身不能证明数据回滚安全。

## 事务验证范围

```sh
python3 -m unittest discover -s scripts/codex-release -p 'test_*.py' -v
```

测试使用临时目录与模拟服务，验证成套切换保留其他 Compose 字段与宿主 runtime、健康失败恢复、入口关闭后出现任务会中止、显式回滚、配置漂移阻止回滚，以及后台会话排队消息会阻止发布。它不执行正式发布，也不宣称经过生产切换演练。
