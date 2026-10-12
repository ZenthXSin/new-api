# ZCode 审查面板源码移植说明

上游项目：https://github.com/zai-org/ZCode
固定版本：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`
上游许可：Apache-2.0。适配文件保留来源、固定提交、修改说明和 SPDX 标记；完整上游 LICENSE/NOTICE 由本发布的 ZCode 第三方声明统一提供。New API 原文件的 QuantumNous 及 AGPL 许可头保持不变。

此次直接移植的展示源码：

| 本地文件                           | 上游文件/区块                                                                               | 适配内容                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lightweight-diff-preview.tsx`     | `packages/ui/src/components/ui/lightweight-diff-preview.tsx`                                | 保留行分类、增删背景/侧边条、粘性行号、所有行共享 max-content 宽度的滚动布局、代码 marker 剥离。将工具路径和设置类型改为本地输入；删去上游专有截断 marker 国际化，由 New API 既有截断提示负责；行号可接真实 hunk 行号；CSS 变量接隔离的 ZCode 主题。 |
| `patch-lines.ts`                   | `packages/ui/src/lib/patchDiffPreview.ts` 的 `getPatchPreviewLineContent`                   | 原版 marker 剥离函数；新增 New API unified diff 解析适配，保留正文 `---` / `+++` 行、真实行号、重命名和权限等元信息。无 `@pierre/diffs` 依赖。                                                                                                       |
| `git-pane-change-card.tsx`         | `packages/ui/src/GitPaneChangeCard.tsx` 的原生按钮、文件名/目录/增删数、展开内容布局        | 接 New API diff 字符串和打开文件回调；使用已移植轻量 diff；删除本机文件管理器、桌面 context menu 和 rich diff worker；窄屏按钮增加触摸高度。删除文件不提供不可用的打开动作。                                                                         |
| `workspace-file-tree-row.tsx`      | `packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx` 的 `rowElement` 展示区块 | 保留紧凑行、文件名截断、目录箭头和单击主要动作；现有 API 为平铺目录列表，采用原生按钮语义；去除桌面拖拽、外部编辑器、虚构 Git 状态与 context menu。手机保留 44px 触摸高度。                                                                          |
| `workspace-file-tree-row-name.tsx` | `packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowName.tsx`                          | 原版路径分段展示，按项目规范格式化并将 React key 改为路径前缀。                                                                                                                                                                                      |
| `side-pane-tab.tsx`                | `packages/ui/src/app-shell/SidePaneTabTrigger.tsx` 的 tab trigger 和 content 展示区块       | 保留原版 tab 尺寸、等比例压缩、选中/hover/焦点颜色和图标标题结构；以原生受控按钮接已有三个面板，去除未提供的拖拽及桌面操作；键盘导航和脏文件保护由 New API 管理。                                                                                    |
| `preview-breadcrumb.tsx`           | `packages/ui/src/PreviewPane.tsx` 的 header breadcrumb 区块                                 | 保留紧凑横向路径、目录箭头、文件图标和文件名；使用现有路径和 Lucide 图标；保留路径局部滚动。                                                                                                                                                         |

`workspace-inspector.tsx`、`workspace-diff.tsx`、`workspace-files.tsx`、`workspace-file-editor.tsx` 已实际导入这些组件。原有 HTTP 请求、管理员权限、读写 hash 校验、保存冲突下载、离开编辑器确认、CodeMirror 撤销重做和快捷键保留。日志面板沿用现有数据结构，并采用 `app-shell/BackgroundBashOutputSidePane.tsx` 的 `bg-panel`/状态区/等宽正文展示类组合；没有引入上游后台命令协议。

复用范围是上述前端展示源码；没有安装或调用 ZCode 平台后端、遥测、付费服务、桌面壳、本机文件管理器或原生编辑器桥接。

验证：原文件操作测试 `workspace-files.test.tsx`（18 项）和新增 `zcode-review.test.tsx`（4 项）覆盖 API 打开路径、保存/冲突/草稿/撤销重做、键盘 tab、长路径、source diff 行号、展开折叠、删除文件和无 hunk 的元信息。
