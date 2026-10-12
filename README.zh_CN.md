# New API

[English](./README.md) · [简体中文](./README.zh_CN.md)

> 基于 [New API](https://github.com/QuantumNous/new-api) 的独立定制分支：保留并改造多模型 API 网关，同时加入浏览器版 Codex 工作台和应用服务。

## 与上游的主要区别

| 方向 | 本分支 |
| --- | --- |
| 模型网关 | 延续并定制 New API 的多渠道、用量和额度流程；中继、认证和前端也有较大改动。 |
| Codex 工作台 | 新增浏览器任务、项目与多会话、审批和消息队列、文件编辑与差异查看，以及 GitHub、SSH 项目连接。 |
| 执行环境 | 新增按用户管理的 Docker/宿主机工作流、环境生命周期与资源控制、可选端口管理和图像任务；runner 需要单独配置。 |
| OAuth 与应用服务 | 扩展 OAuth 授权和托管操作；新增应用中心，支持版本、安装包、公告、客户端更新检查和遥测，并提供可选的应用收款流程。 |
| 上游扩展模块 | 原版的一部分任务插件体系及其 API 文档在本分支中已移除或重构，因此这不是与原版功能完全一致的替代品。 |

改动覆盖后端、前端、中继、认证和部署配置。合并上游更新或迁移数据前，请先核对兼容性。

## 文档

- [New API 上游文档](https://docs.newapi.pro/zh/docs)
- [Codex 工作台与 runner 部署](./docs/codex/README.zh-CN.md)
- [OAuth 平台与应用收款](./docs/oauth-full-access/README.zh-CN.md)
- [应用中心 API](./docs/application-center.md)
- [Codex 图像任务](./docs/codex-image-tasks.md)
- [Codex 端口管理](./docs/codex-frp-ports.md)
- [Codex 环境隔离](./docs/codex-home-isolation.md)

## 构建与部署

仓库根目录的 `docker-compose.yml` 默认使用上游镜像 `calciumion/new-api:latest`，该镜像不包含本分支的代码。

从当前源码构建镜像：

```sh
docker build -t new-api:local .
```

启动 Compose 前，将 `docker-compose.yml` 中 `new-api` 服务的镜像改为 `new-api:local`。部署前请替换示例数据库和 Redis 凭据。

Codex 工作台还需要单独配置宿主机 runner 和 worker 镜像。请按 [Codex 部署文档](./docs/codex/README.zh-CN.md) 配置；单独启动网关不会启动 runner。

## 许可证与署名

本项目采用 [AGPL-3.0](./LICENSE) 授权，附加条款见许可证和 [NOTICE](./NOTICE)。项目基于 [QuantumNous 的 New API](https://github.com/QuantumNous/new-api)。

根据许可证要求，修改版本必须保留署名文字 “Frontend design and development by New API contributors.”，并在显著位置保留指向原项目的链接。
