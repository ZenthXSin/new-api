# ZCode 前端源码复用

上游：[zai-org/ZCode](https://github.com/zai-org/ZCode)，固定提交 [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)。本站于 2026-10-06 直接移植并修改以下展示层源码，原始文件保存在发布目录 `references/zcode/`，不将上游服务端或整个仓库作为运行依赖。

## 许可与原文

- [LICENSE](LICENSE)：ZCode 根 Apache-2.0 许可证，保留原文。
- [UPSTREAM-NOTICE.md](UPSTREAM-NOTICE.md)：上游根 `NOTICE.md` 原文；其中桌面、账户、支付、网关和遥测等说明描述上游产品，不代表本站接入这些服务。
- [COPIED-SOURCE-NOTICES.md](COPIED-SOURCE-NOTICES.md)：从同一提交的 `THIRD-PARTY-NOTICES.md` 提取并原样保留的相关复制源码声明。AI Elements 部分为 Copyright 2023 Vercel, Inc. / Apache-2.0；shadcn UI 与样式部分为 Copyright (c) 2023 shadcn / MIT。

New API、QuantumNous 的原有版权、品牌及 AGPL 声明保持不变。各依赖包继续遵守其各自许可。组件文件的标头和下列出处说明记录适配范围；本目录不表示获得上游商标授权，也不表示本站实现 ZCode 的所有功能。

## 直接移植的展示层

| 本站文件        | 上游源码与适配                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme.css`     | `packages/ui/src/styles.css` 中 Zai Light / Dark 主题变量及 UI 字号。限定到 Codex 作用域，映射本站 Tailwind token，省略桌面和全局 reset。                                                                                         |
| `button.tsx`    | `packages/ui/src/components/ui/button.tsx` 的 variants / sizes；`cn` 接本站工具，省略未使用的 Radix Slot。                                                                                                                        |
| `shell.tsx`     | `WorkspaceSidebar/WorkspacePurposeSection.tsx`、`WorkspaceSidebarItem.tsx` 的分组和项目行展示，以及 `v4/ConversationDraftEmptyState.tsx` 的定时问候和居中布局。项目回调、语言和图标接本站，不包含桌面拖拽、账户或 provider 服务。 |
| `conversation/` | 消息、Markdown、代码块、表格、列表、引用、Mermaid 和工具过程展示；每个文件的上游位置、源区间及适配见 [CONVERSATION-PROVENANCE.md](conversation/CONVERSATION-PROVENANCE.md)。                                                      |
| `inspector/`    | 文件树行、预览路径、侧栏页签、变更卡、补丁解析与轻量差异展示；7 个文件的来源、扩展和浏览器边界见 [PROVENANCE.zh-CN.md](inspector/PROVENANCE.zh-CN.md)。                                                                           |

发布构建同时分发 `/licenses/zcode/` 下的许可、上游 NOTICE、复制源码声明和简短来源说明，便于部署后直接查阅。

会话数据、任务执行、项目文件和个人环境仍由 New API / Codex runner 提供。复制的展示组件通过明确的 props 和回调连接已有 API；不带入 ZCode 登录、Coding Plan、支付、反馈、遥测、模型网关、MCP、插件市场或 Electron 运行时。Markdown 图片可能向原始内容指定的 HTTPS / HTTP 资源地址发起浏览器请求，外部链接由用户点击后打开，这不是 ZCode 业务服务接入。
