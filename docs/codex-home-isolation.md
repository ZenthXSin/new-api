# Docker 环境的 Codex 目录

每个用户拥有独立的长期 Docker 环境。容器默认设置：

```text
HOME=/home/codex/user
CODEX_HOME=/home/codex/user/.codex
```

该目录映射到服务器 `users/<owner>/home/user/.codex`，以 0700 权限创建，由容器用户管理。不同用户环境不会挂载同一份 home；容器停止、重启、切换模式或重新创建时保留目录内容。

在线任务继续使用独立的项目目录 `users/<owner>/home/workspaces/<workspace>/.codex`，避免项目间混用会话数据库、缓存和配置。更新不移动或重写现有任务历史。

升级后，缺少默认 `CODEX_HOME` 的旧容器会在启动时以原有持久目录重新创建。部署前应检查所有任务均已空闲。
