# New API

![new-api](/web/public/logo.png)

[English](./README.md) · [简体中文](./README.zh_CN.md)

> An independently maintained customization of [New API](https://github.com/QuantumNous/new-api), combining its multi-model API gateway with a browser-based Codex workbench and application services.

## What differs from upstream

| Area | This fork |
| --- | --- |
| Model gateway | Retains and customizes New API's gateway, channel, usage, and quota flows. Relay, authentication, and frontend code have also diverged. |
| Codex workbench | Adds browser-based Codex sessions, projects, approvals, message queues, file editing and diffs, plus GitHub and SSH project connections. |
| Execution environments | Adds per-user Docker/host workflows, environment lifecycle and resource controls, optional managed ports, and image-task support. The runner must be configured separately. |
| OAuth and app services | Extends OAuth authorization and managed operations; adds an application center for releases, downloads, announcements, client update checks, and telemetry. Optional application payment flows are available. |
| Upstream extensions | Some upstream modules, including parts of the task-plugin system and its API documentation, have been removed or reworked. This is not a feature-for-feature drop-in replacement. |

The changes span the backend, frontend, relay, authentication, and deployment paths. Check compatibility before rebasing upstream changes or migrating data.

## Documentation

- [Upstream New API documentation](https://docs.newapi.pro/en/docs)
- [Codex workbench and runner](./docs/codex/README.zh-CN.md)
- [OAuth platform and application payments](./docs/oauth-full-access/README.zh-CN.md)
- [Application center API](./docs/application-center.md)
- [Codex image tasks](./docs/codex-image-tasks.md)
- [Managed Codex ports](./docs/codex-frp-ports.md)
- [Codex home isolation](./docs/codex-home-isolation.md)

## Build and deployment

The root `docker-compose.yml` points to the upstream `calciumion/new-api:latest` image. That image does not include this fork's code.

To build this source, create a local image:

```sh
docker build -t new-api:local .
```

Then change the `new-api` service image in `docker-compose.yml` to `new-api:local` before starting the stack with Docker Compose. Replace the example database and Redis credentials before deployment.

The Codex workbench also requires its separate host runner and worker image configuration. Follow the [Codex deployment guide](./docs/codex/README.zh-CN.md); starting the gateway alone does not start the runner.

## License and attribution

This project is licensed under [AGPL-3.0](./LICENSE), with additional terms described in the license and [NOTICE](./NOTICE). It is based on [New API by QuantumNous](https://github.com/QuantumNous/new-api).

Modified versions must preserve the attribution text “Frontend design and development by New API contributors.” and a visible link to the original project, as required by the license.
