# New API Codex 容器公网端口

每个用户 Docker 容器最多同时分配 10 个 TCP 公网端口。进入在线 Codex「设置 → Docker → 公网端口」，填写容器内部端口即可自动分配公网地址；关闭映射会归还配额。容器停止时关闭转发及对应防火墙规则，重新启动后恢复已保存的映射。端口转发不依赖用户浏览器保持打开。

新建 Codex 会话可调用 `codex_list_ports`、`codex_open_port`（`localPort`、可选 `label`）、`codex_close_port`（映射 `id`）。工具只管理当前账户的 Docker 容器；每次操作重新检查会话与 Docker 使用权限。Ask 模式只读，Code 模式需要批准变更，自动批准与完全访问模式直接执行。已有原生会话继续保留历史，工具通过原生 `thread/start` 注入，因此需新建会话使用新增工具。

## 部署

在宿主机准备 FRP 0.71.0 的 `frpc`、`frps`、`LICENSE`，执行：

```bash
python3 scripts/codex-release/setup-frp.py --public-host <主机公网IPv4> --vendor <FRP目录>
```

安装器只配置自己的 `new-api-codex-frps.service`、`NEWAPI_CODEX_FRP` 防火墙链及 Runner 环境变量，不重启正在运行的 Codex 任务。Runner 在下一次正常版本部署时启用功能。公网端口池为 30000–39999；安装前检查既有监听端口冲突。FRP 服务只绑定指定公网 IPv4，控制连接绑定工作容器桥接地址 172.31.240.1:7430，并强制 TLS 与令牌认证。

`/etc/new-api-codex-frp` 存放私有凭据。`/var/lib/new-api-codex/ports` 保存分配记录与每用户客户端配置。FRP 客户端由宿主机 systemd 运行，只加入对应容器网络命名空间，可转发容器内 127.0.0.1 服务；凭据不挂载到容器。容器内部管理端口 7401 保留，不能开放。用户不能指定宿主机地址、其他用户、凭据或公网端口。

参考：[FRP 服务端配置](https://gofrp.org/en/docs/reference/server-configures/)、[FRP 客户端配置](https://gofrp.org/en/docs/reference/client-configures/)。
