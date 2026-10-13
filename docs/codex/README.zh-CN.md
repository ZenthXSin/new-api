# New API Codex 管理员工作台完整中文文档

源码说明更新：2026-10-10。本文按当前源码说明在线 Codex、账号授权、个人环境、项目、多会话、模型分组、消息队列、GitHub、SSH 与文件能力。历史版本发布与迁移记录保留在后文；当前构建和部署结果以成套发布目录的 manifest、事务记录及验证报告为准。

管理员入口：`https://ai.example.com/codex`。

2026-10-06 版本直接复用了 [ZCode 官方开源仓库](https://github.com/zai-org/ZCode) 的 UI 与 Markdown 源码，固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。已适配源码位于 `web/src/features/codex/vendor/zcode/`，包括明暗主题、按钮、项目侧栏、会话和工具过程、Markdown、文件与差异审阅组件，接入本站已有数据和任务 API。保留 ZCode Apache-2.0、Vercel AI Elements 和 shadcn 的相关原文声明，也保留 New API / QuantumNous 的原有品牌和 AGPL 条款。未接入 ZCode 账户、支付、遥测、模型网关或桌面运行时，不宣称实现上游全部功能；具体源码范围见 `docs/codex/FRONTEND-DESIGN.zh-CN.md` 与 vendor 来源清单。

## 定位与权限

New API 提供 Codex 网页界面、账号与会话权限校验、项目与会话管理；真正的 Codex App Server 在服务器 Docker 环境中执行任务。用户只需要网站，不需要安装本地客户端。界面参考 Codex 的项目、任务、消息、文件与变更查看流程，不把未接入的闭源官网能力列为已实现。

管理员默认可以进入工作台；普通用户需要管理员在账号 Codex 配置中启用访问，并分别授予 Docker 或 SSH 执行权限。导航、路由和所有 `/api/codex` 接口均校验当前有效的浏览器会话与账号权限。外部 OAuth 应用与 API 令牌不能使用这些工作台接口；任何账号都不能通过项目 ID 读取其他账号的项目、文件、审批或进度。

模型请求继续经过已有 New API 渠道、分组、额度和计费规则。当前浏览器发送任务时，Go 网关按当前账号的有效登录会话、所选模型和分组签发短期模型凭据；凭据只允许对应模型的 Responses 请求，并将用量计入当前账号。没有另建项目收费或资源账单系统。runner 的静态专用模型令牌配置仍用于兼容运行配置，不应把旧版共享令牌计费方式当成当前网页任务的路径。

## 一个用户、一个个人环境、多个项目

隔离边界现在是用户。同一个 New API 用户 ID 对应一个 Docker 个人环境，用户创建多个项目不会按项目增建容器；不同用户的环境不挂载彼此的数据。普通用户是否可以启动 Docker 或 SSH 环境由其账号 Codex 配置决定。

一个项目保存自己的项目文件和多条 Codex 会话；每条会话拥有独立原生线程、消息、审批、事件游标、请求编号和待发队列。项目内会话共享项目文件。多个本地项目共用用户的 Docker 执行环境，不自动合并对话或混用项目目录。项目在网页和文件 API 中有各自边界，但同一用户容器内运行的代码具有访问该用户其他项目的权限；同用户项目之间不是独立安全沙箱，不宜将相互不信任的代码当作已完全隔离。

| 对象 | 作用与生命周期 |
| --- | --- |
| 用户 | 个人环境的所有者；不同用户之间隔离 |
| 个人环境 | 当前用户共用的 Docker 执行环境；可手动启动、休眠，空闲后自动休眠 |
| 项目 | 独立文件目录和多条 Codex 会话，可重命名、归档、恢复或删除 |
| 会话 | 每项目最多 100 条，分别保留历史、模型参数和任务；可重命名、归档、恢复或删除 |
| 任务轮次 | 一次提示词触发的执行，可连续追问、审批或中断 |

个人环境休眠只停止运行进程，不删除项目、会话与持久化 home。重新启动会使用已有数据；内存、终端进程与临时目录不会恢复。删除一个项目只删除该项目的数据和会话，不删除用户的个人环境、其他项目或共享 home。归档只从活动项目列表收起项目，恢复后可继续使用。

同一用户一次只能有一个活动任务，覆盖其所有项目；全局默认最多同时运行两个用户环境，包括手动启动但暂时没有任务的环境；每个运行环境仍一次最多执行一个任务。第三个用户需等待空闲环境自动休眠，或由环境所属用户手动休眠后再启动。用户某个项目正在启动、执行或等待审批时，其他项目可以阅读文件和会话，但不能再启动任务，也不能创建、删除、编辑文件、导入或导出项目。网页显示正在占用环境的项目，并提供返回该项目的入口。服务端同样执行限制，不依赖按钮是否禁用。

## 执行权限模式与批量管理

输入框的“审批模式”提供四种选择。默认保留逐次审批；用户选择会记住到该账号的浏览器偏好，新任务使用偏好，已有会话继续恢复自身保存的模式。

| 模式 | 执行行为 |
| --- | --- |
| 逐次审批 (`code`) | 原生 `on-request`；需要审批的命令、文件变更交由用户处理 |
| 自动批准 (`auto`) | 原生 `never`，自动批准命令、文件与权限请求；仍在个人 Docker 环境或已授权 SSH 账号中运行 |
| 完全访问 (`full-access`) | 原生 `never` 和 `dangerFullAccess`；允许操作该用户执行环境内的文件、命令与网络 |
| 只读 (`ask`) | Docker 项目以只读挂载，SSH 使用原生只读策略 |

自动批准与完全访问仍会显示缺少必要信息时的用户问题，不把回答问题当作命令审批。完全访问不会改变跨用户隔离、Docker 宿主挂载或站点账户权限。

侧边栏“项目”标题旁的批量管理按钮可以切换项目与会话，搜索、筛选归档状态、全选当前列表，然后归档、恢复或删除。运行中项目和会话不可选择；删除需要确认数量。批量操作逐项调用现有服务端接口，部分失败时保留失败项和原因供重试，刷新成功项；删除当前会话时切换到服务端返回的替代会话。

GitHub 授权返回 `/codex?github_oauth=1` 时，路由保留回调标记、code 与 state 的字符串值。页面提交授权回调并刷新连接及仓库相关查询，自动打开 GitHub 标签；拒绝授权与过期授权显示可重连的错误。回调参数随后从地址栏移除。之前没有提交回调的旧授权需要重新连接一次。

## 日常使用

1. 使用已启用 Codex 权限的账号进入 Codex 页面。创建空项目、导入公开或已授权 GitHub 仓库，或连接 SSH 远程项目；已有项目和会话从侧栏打开。
2. 查看页头个人环境状态，按需展开资源、休眠和活动项目详情。无需先手动启动；发送任务会自动唤醒，单独启动环境不会发送模型请求。
3. 在输入区选择模型、推理强度与 Code / Ask，描述任务后发送。Enter 发送、Shift + Enter 换行，中文输入法组合期间不会误触发发送。
4. 先阅读助手回复与任务状态，需要核对时展开“执行过程”查看命令、推理摘要和文件修改。需要确认或回答 Codex 问题时按页面操作。
5. 打开文件、变更或命令历史审阅结果；文件可筛选、查看和明确进入编辑，代码编辑器支持语法着色、行号与撤销/重做。变更面板列出修改文件和逐行差异，支持下载补丁或导出项目。
6. 在当前会话继续发送消息会延续其原线程；新建会话使用新的线程并共享项目文件。Codex 工作时可准备草稿、排队下一条消息或选择停止当前任务后发送。空闲时可从个人环境入口休眠，或等待自动休眠。

Code 允许修改当前用户的项目文件与运行命令；Ask 将当前用户的全部项目挂载为只读，而不仅是当前项目。Ask 下持久化 home 与临时目录仍可写，供 Codex 保存会话、缓存和日志。模式作用于整个用户环境；同为 Code 的任务切换项目会复用同一个容器，切换 Code / Ask 时会先停止并移除旧容器，再创建同名容器以改变挂载模式，保留持久化文件和历史，结束原来的运行进程。一个用户不会因此同时保留两个运行容器。

模型与推理强度来自服务端允许列表，浏览器不能指定任意供应商地址、宿主目录、环境变量或沙箱权限。提示词须非空，最多 100000 字符；项目名称为 1–120 字符。每次提交使用 UUID 请求编号，同一编号与相同内容的重试不会开启第二轮任务；同一编号改为不同内容会返回冲突。

网页按游标读取服务端事件，活动任务约每秒更新，空闲时降低频率。事件超出重放窗口时重新读取完整会话快照，不通过重复追加旧增量拼接回复。刷新网页或暂时断网不主动停止服务器任务；重新连接读取已有进度，不会自动重复发送上一次提示词。

桌面会话与项目审阅面板可以拖拽分隔线调整宽度，也支持键盘调整；两侧独立滚动。手机按需打开项目列表或审阅面板，关闭后回到原会话和草稿。个人环境入口并入页头，资源详情不持续占用会话高度。

草稿和待重试的请求编号按当前账号、登录会话、项目和对话保存在该浏览器标签页的 `sessionStorage`，方便切项目、刷新与断线恢复；这不等于已发送到服务器的会话，也不承诺关闭标签页或更换设备后仍保存。服务器仅收到明确发送的任务。新输入在发送请求期间暂停编辑，模型执行期间可继续准备下一条消息。

“日志”面板展示 Codex 已运行命令的输出，不是独立交互式终端。GitHub OAuth 和 SSH 已有真实接口；公开会话分享、团队项目共享、GitHub App、专用 PR 发布按钮、浏览器虚拟机和 IDE 插件市场不能仅靠展示入口视为完成。

## 多会话、排队与会话导出

会话创建、重命名、归档、恢复和删除由 runner 持久化。归档会话仍保留历史，但需要恢复后才能提交任务；删除会话保留项目文件和其他会话，删除最后一条会话后项目仍然存在并建立新的会话身份。项目 ID 和会话 ID 是不同字段，请求可通过 `?conversation=<UUID>` 指定对话。

同一管理员的多个项目/会话共享一条执行队列。最多可排队 20 条消息，按提交顺序执行；停止并发送的新消息优先于队列。排队消息可以取消，runner 重启后保存为暂停状态，需要用户恢复以重新授权。请求编号及内容指纹确保重试不重复执行；已发给 Codex 但确认超时的请求不会自动重新发送。

会话导出使用当前已加载的 `detail.thread`，包括各轮可见消息、公开推理摘要、命令及输出、文件补丁、计划和真实错误。Markdown 便于阅读，JSON 使用 `schema: new-api.codex.conversation`、`schemaVersion: 1` 与 `scope: visible-conversation`。导出尊重消息显示删除标记；未发送草稿、队列、其他会话、文件字节、原生 Codex home 和服务凭据不属于此格式。分支信息自动从当前会话读取，保留真实 `rootConversationId`、`revisionId`、`parentRevisionId`、`replayTurnId`、`turnIndex` 和 `version`，不虚构父会话关系；分支标识仅说明所选分支，不表示导出了其他分支。它是可读会话记录，不是可恢复的原生完整备份。

## GitHub 与 SSH 连接

### 一次授权访问全部仓库

如果希望用户首次连接时一次申请全部公开和私有仓库的开发权限，请为 Codex 配置独立的 **GitHub OAuth App**。连接请求会同时申请 `repo read:org workflow`：仓库代码、提交、Issue、Pull Request 和工作流权限在同一个 GitHub 授权页确认，不需要逐个选择个人仓库。组织仓库仍受组织的第三方应用与 SSO 策略约束。权限范围见 [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)。

1. 在 [GitHub 注册 OAuth App](https://github.com/settings/applications/new)，回调地址填写本站的 `https://<网站域名>/codex?github_oauth=1`。当前连接实现尚未管理 OAuth App 的刷新令牌；按 [GitHub 注册文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) 的兼容要求，注册时取消勾选 `Expire user access tokens`。
2. 如果此前已用另一个 App 连接 Codex，先在旧配置生效期间断开旧连接并完成凭据撤销，再切换配置。断开连接会停止该用户相关执行进程，请等任务结束后操作。
3. 将新 App 的 `CODEX_GITHUB_CLIENT_ID` 和 `CODEX_GITHUB_CLIENT_SECRET_FILE` 配置给 **New API 服务**。Secret 文件需要以只读方式挂载到 API 容器，文件路径填写容器内路径；也支持服务端的 `CODEX_GITHUB_CLIENT_SECRET`。若使用 `CODEX_GITHUB_REDIRECT_URI`，其值必须与注册回调地址一致。这些配置独立于网站登录使用的 GitHub App。
4. 更新 API 服务配置后，用户点击“连接 GitHub”，在同一授权页确认权限即可。凭据保留在服务端，仓库列表按用户自身权限加载。

### GitHub App 的仓库安装授权

GitHub App 的登录授权与仓库安装授权分开进行。连接成功只代表身份授权完成；要访问私有仓库，还需将同一个 App 安装到仓库所属的个人或组织账号，并在 GitHub 安装页选择这些仓库。连接页、新建项目和云端环境仓库选择器提供“授权仓库”和“刷新仓库”入口，刷新会重新获取当前账号的连接及仓库列表，并保留已选择的仓库。

管理员可设置 `CODEX_GITHUB_APP_SLUG`（GitHub App 页面 `/apps/<slug>` 中的 slug），让授权按钮直接打开该 App 的安装页。未设置时使用 GitHub 的授权应用设置页。组织的安装或权限变更可能需要组织管理员批准；App 本身还需配置读取仓库内容的权限，才能克隆私有仓库。OAuth App 使用 `repo` scope，仍按其已授予的权限读取列表。

GitHub 开发授权与网站登录绑定分开管理。管理员通过 `/github/authorize` 开始 OAuth，在当前浏览器完成回调后可读取已授权仓库列表；创建项目可选公开仓库或授权可访问的仓库。凭据由 Go 服务端注入 runner，浏览器不接收仓库访问令牌。断开连接会撤销供应、停止该用户相关执行进程并尝试撤销提供方凭据；部分清理失败会显示待完成状态，可重试。

SSH 连接先探测并核对主机指纹，再使用 SSH 凭据保存属于该管理员的连接。远程项目指定连接和现有绝对目录；文件操作、Git 和 Codex 命令实际在该服务器执行。远端需要 Python 3.8+、Git 和可写用户 home；Linux x86_64 可安装固定 Codex 运行包，其他架构要求自行提供兼容 Codex。远程 Code 使用已授权 SSH 身份，Ask 使用只读执行策略；它不是本地 Docker 容器的隔离机制。删除工作台远程项目会保留远端文件。

管理员主机项目可以使用主目录（例如 `/root`）作为服务器入口，启动时不会递归扫描整个主目录建立 Git 快照。该入口仍支持命令与文件操作；若需要“变更”面板的文件差异追踪，请选择具体项目目录。普通主机项目继续保留工作台快照和差异查看。

若主机或远程目录初始化返回 `remote_operation_failed`，且请求尚未发送给 Codex，修复环境后可以直接重试保留的草稿并使用同一请求编号。已经发送、确认状态未知、已取消的请求或会话分支操作继续保留原有去重规则。

## Markdown 与展示组件来源

页面的侧栏、会话和输入区由本站前端组件组织；Code / Ask、模型、推理强度、草稿恢复、发送、停止和确认请求连接真实任务 API。2026-10-06 的 Zai 明暗主题属于上一版外观；当前 UI 外观以本轮前端代码与浏览器验收为准。文件、变更、日志继续由真实项目 API 提供。

助手 Markdown 改用从 ZCode 移植的 `MessageResponse` / Streamdown 渲染链，包括中文文本、标题、列表、引用、代码、表格、数学公式与 Mermaid。流式生成时处理未闭合语法，完成后转为静态渲染和代码高亮。单美元处理避免将金额、价格区间、`$HOME` 等常见文本误当作公式。

代码块支持语言标签、复制和自动换行；表格支持复制为 Markdown 与下载 CSV。宽表格和长代码在各自区域滚动。Mermaid 在预算内绘图，SVG 清理后展示；非法、超预算或失败时保留代码内容。原始 HTML 不执行，HTTP / HTTPS 外链由用户点击打开；远程图片仍可能按消息内容向对应网站发起请求，桌面本地文件协议及上游媒体服务未接入。

文件和差异面板直接使用移植的文件树行、路径面包屑、侧栏页签、变更卡与轻量差异展示，差异行号来自实际补丁。CodeMirror 编辑、保存哈希校验、冲突下载和离开未保存文件的确认继续保留。完整出处、许可、适配边界及前端验证方案见源码内的设计文档和 vendor 清单。

## 环境状态与任务状态

个人环境状态独立于当前项目的任务状态。没有任务也可能有正在运行的个人环境；环境休眠后仍可读取已保存项目和历史。

| 环境状态 | 含义 |
| --- | --- |
| `not_created` | 尚无个人环境容器，可以启动或在任务开始时创建 |
| `stopped` | 环境已休眠；持久化项目和会话仍保留 |
| `starting` | 正在创建或启动环境，避免重复操作 |
| `running` | 环境已运行，不一定有活动模型任务 |
| `error` | 环境异常，查看返回原因后处理 |

环境接口同时返回当前模式、活动项目 ID 与名称、项目数量、自动休眠时长和资源限制。活动任务期间停止环境返回 `409 environment_busy`，必须先停止任务或等待其结束；网页不会将停止环境当作强制终止所有项目的快捷操作。

| 项目任务状态 | 含义 |
| --- | --- |
| `idle` | 没有活动任务；还需看个人环境是否被其他项目占用 |
| `starting` | 正在启动执行或发送任务 |
| `running` | Codex 正在执行 |
| `waiting_approval` | 等待确认或回答问题，仍占用个人环境 |
| `interrupted` | 用户停止、进程退出或服务重启；核对记录后明确继续 |
| `error` | 该轮任务发生错误，不表示结果已成功完成 |

“停止任务”先向 Codex 请求保存中断状态，再结束该项目的 App Server 和执行进程；个人 Docker 环境继续保留并可保持运行，下次发送消息恢复该项目原会话。“休眠环境”才停止整个用户容器，且要求先没有活动任务。两项操作都不会删除持久化项目数据。

审批卡先展示操作理由、将执行的命令、工作目录或读取/写入权限路径，完整请求详情按需展开。支持命令与文件变更的允许或拒绝，也支持填写 Codex 提问后继续。外部 MCP 表单目前只支持拒绝，未知确认类型由服务端拒绝。页面呈现 Codex 公开返回的推理摘要、命令和代码变更，不构造模型未提供的内部推理过程。

## 项目文件、导入与导出

公开仓库导入要求 HTTPS，禁止账号密码、查询参数、非标准端口、私网和本地地址。只导入空项目，采用浅克隆，不递归拉取子模块。ZIP 导入会先检查全部条目，已有同名路径时拒绝，不静默覆盖。

| 项目 | 限制 |
| --- | --- |
| ZIP 上传 | 压缩后最多 25 MiB，展开总计最多 100 MiB |
| ZIP 条目 | 最多 5000 个；禁止加密、重复路径、链接和特殊文件 |
| 文本编辑 | 有效 UTF-8、不含 NUL，单文件最多 1 MiB |
| 文件路径 | 当前项目内相对路径；禁止绝对路径、`..`、反斜杠、`.git` 和符号链接 |
| 保存冲突 | 校验上次读取的 SHA-256；发生变化返回冲突，不覆盖新内容 |
| ZIP 导出 | 最多 5000 个遍历条目，内容和压缩结果均最多 100 MiB |
| 请求编号记录 | 每项目最多 10000 条；达到后需新建项目 |
| 会话消息容量 | runner 累计原生通知 JSON 约 64 MiB；达到后停止任务并保留已接收内容 |
| 近期事件窗口 | 最多 4000 条、约 8 MiB；旧游标使用完整快照重新同步 |

文件编辑器使用 CodeMirror，提供 JS / TS / JSX / TSX / HTML / CSS / Markdown 语法高亮、行号、活动行与括号匹配。编辑状态下可用 Tab / Shift + Tab 缩进，Ctrl / Cmd + S 保存，Ctrl / Cmd + Z 撤销，Ctrl + Y 或 Cmd + Shift + Z 重做；按 Esc 后再按 Tab 可将键盘焦点移出编辑器。任务运行或进入只读状态时禁止编辑，保留同一编辑器实例及当前草稿；状态变化不会自动将未保存内容丢弃或写入服务器。

项目导出排除 `.git`、`node_modules`、`.ssh`、`.aws`、`.azure`、`.codex`、`.npmrc`、`.pypirc`、`.netrc`、`auth.json`、`.env` 前缀文件及常见证书和私钥扩展名，跳过链接和特殊文件。它不自动识别任意源代码中的秘密，也不包含完整历史、共享 home、依赖缓存或服务配置，不能作为完整灾备。

差异来自项目基线与当前文件的比较，包括未跟踪文件。仓库首次克隆后建立基线；空项目或 ZIP 项目在第一次任务或首次查看差异时记录当时文件。已有基线的项目再次导入文件会形成新增变更，基线不会在每一轮任务后自动重置。

## 持久化与迁移

项目元数据、嵌套多会话快照、事件、请求记录和队列保存在 runner 文件中，Codex 原生会话另有持久化 home。主数据库保存管理员身份、登录会话与 `CodexGitHubConnection` 授权记录；项目历史本身没有迁入 SQL 项目表。SSH 连接认证和远端项目文件另有各自的持久化位置，完整备份需要覆盖这些边界。

状态采用临时文件写入后重命名，生成中的增量以约 200 毫秒合并写入，任务起止和审批等关键状态额外落盘。突然掉电仍可能丢失未完成写入的最后增量。网页显示保存失败时，应先恢复磁盘与目录可写状态，不将失败期间的可见历史视为已备份。

已部署的用户环境版本保留 `state/<项目UUID>.json`、项目 UUID 与 Codex 会话标识，将项目文件及各项目原生会话按所属用户归入以下目录：

```text
/var/lib/new-api-codex/
├── state/<项目UUID>.json
└── users/<New API 用户ID>/
    ├── projects/<项目UUID>/project/       # 该项目文件
    └── home/
        ├── user/                        # 同用户共享 HOME
        └── workspaces/<项目UUID>/.codex/ # 该项目独立 Codex 会话
```

用户全部 `projects/` 挂载到容器的 `/workspace/projects/`，任务当前目录为 `/workspace/projects/<项目UUID>/project`。用户 `home/` 挂载到 `/home/codex`，共享 `HOME` 为 `/home/codex/user`，每个项目单独设置 `CODEX_HOME=/home/codex/workspaces/<项目UUID>/.codex`。因此容器与常规 home 共享，而 Codex 原生会话仍按项目保存，不将各项目历史混为一条会话。

runner 启动先校验状态中的所有者映射、验证并停用旧项目容器，同时停止已有用户容器，再迁移旧 `workspaces/<项目UUID>/project` 与 `home`：前者移动至用户项目目录，后者原样移动至 `users/<用户ID>/home/workspaces/<项目UUID>`。每一目录使用同一文件系统内的重命名，部分迁移后可再次启动继续，不制作第二份并行数据或自动重发历史任务。

若旧位置与新位置同时已有数据、两处同时缺失、路径是符号链接，或旧目录存在预期外文件，迁移拒绝继续并要求管理员核对；不会自动覆盖、删除冲突文件或把其他用户数据合并过来。迁移完成后不留下供旧 runner 使用的旧布局软链接。因此回滚到旧项目容器版本必须与升级前完整快照或已核对的反向迁移配套，不能直接切回旧二进制。

每个项目首次启动新版 App Server 前，在容器内重定位其 Codex SQLite 索引中的旧会话文件路径和工作目录；原 JSONL 会话内容与提示词不修改。原项目 `.workbench` 差异基线随旧 home 一起保留。手动迁移脚本为 `codex-runner/migrate-user-environments.mjs`，示例：

```bash
/opt/new-api-codex/bin/node /opt/new-api-codex/migrate-user-environments.mjs --data-dir /var/lib/new-api-codex --dry-run
```

`--dry-run` 只显示迁移计划，不证明所有目录冲突已经消除。实际迁移用 `--apply`，执行前必须先停止 runner 和所属执行容器并保存完整数据备份；生产升级可由新版 runner 初始化执行同一迁移路径。

runner 重启将原先执行中的任务标为中断，清除失效待确认请求并停止旧执行进程。下次明确提交时从原项目会话继续，不还原已经丢失的终端进程或内存。停止任务时，命令可能已产生部分文件或外部副作用；继续前应核对命令结果和变更，不能假定被中断的操作全部没有发生。

## Docker 与网络隔离

个人环境是执行用户项目代码的边界，容器名称为 `new-api-codex-user-<New API 用户ID>`。runner 是受信任的宿主机管理器，通过 Docker 控制每个用户唯一的环境；浏览器与 New API 应用容器不持有 Docker socket。runner 不向浏览器返回模型密钥、宿主路径或任意执行接口。

| 项目 | 当前约束 |
| --- | --- |
| 容器身份 | UID / GID `1000:1000` |
| CPU、内存 | CPU 使用 `CODEX_WORKER_CPU_PERCENT`，默认 5%；内存使用 `CODEX_WORKER_MEMORY_MB` 固定额度，默认 2048 MB；账号可覆盖额度，实际字节数由环境 API 返回，不另加 swap |
| 进程、文件句柄 | 256 个进程、4096 个文件句柄 |
| 根文件系统 | 只读；删除全部 capabilities，启用 `no-new-privileges` |
| 持久化挂载 | 仅该用户的项目和 home，不挂载其他用户、宿主 root 或 Docker socket |
| 临时目录 | `/tmp` 256 MiB，`/run` 16 MiB，停止后不承诺保留 |
| 磁盘约束 | 每用户汇总软上限 2 GiB，约 15 秒检查；宿主数据盘至少余 1 GiB |
| 任务并发 | 每用户 1 个活动任务，全局默认最多 2 个运行环境（含手动启动后的空闲环境） |
| 自动休眠 | 默认空闲 600 秒停止个人环境，不删除数据 |

磁盘巡检覆盖所有运行中的用户容器，包括没有活动任务的后台进程和没有项目时的共享 home，超限会停止整个用户环境并保留文件。软磁盘上限不是内核硬配额，检查周期内可能超出。项目数量不能通过增加容器获得额外的用户磁盘额度。资源上限限制环境，并不保证任意依赖安装和大型编译都能在该额度内完成。

Codex 固定版本 `0.160.0`，通过 `app-server --listen stdio://` 与 runner 交换 JSON-RPC，会话与任务通知再由管理员 API 提供给网页。采用 `externalSandbox`，执行边界由 Docker 配置落实，不增加 `privileged` 或 `SYS_ADMIN` 以运行嵌套沙箱。[官方 App Server 文档](https://developers.openai.com/codex/app-server/)

执行网络禁止访问其他用户容器、私网服务及元数据地址，保留公网 HTTP / HTTPS 和指定 DNS。同机 New API 仅允许宿主 HTTPS 443 入口，不开放 SSH、数据库、Redis 或 runner 控制端口。实际规则由 `setup-worker-network.sh` 与 `setup-control-network.sh` 安装，Docker 或防火墙重启后需重新执行网络初始化单元。

任务的短期模型凭据会提供给执行环境中的 Codex，只允许绑定的模型与分组执行 Responses 请求，并持续校验原登录会话和当前权限。同一执行身份的项目代码不能被视为对该凭据完全隔离。执行环境不接收管理员登录 access token、渠道上游密钥或宿主 Codex 登录资料；GitHub 凭据在授权仓库任务中按需供应。已知秘密精确值脱敏不等同于任意秘密自动清除。

## 服务与配置

| 项目 | 路径或设置 |
| --- | --- |
| 网页入口 | `https://ai.example.com/codex` |
| runner 程序与 Node | `/opt/new-api-codex/`、`/opt/new-api-codex/bin/node` |
| runner 服务 | `new-api-codex.service` |
| 网络初始化 | `new-api-codex-network.service` |
| 持久化数据 | `/var/lib/new-api-codex/` |
| runner 环境配置 | `/etc/new-api-codex/runner.env` |
| 服务认证 | `/etc/new-api-codex/runner.key`，权限 `0600` |
| 专用模型令牌 | `/etc/new-api-codex/model.key`，权限 `0600` |
| 用户执行网络 | `new-api-codex-workers`，`172.31.240.0/24` |
| 控制网络 | internal bridge，`172.31.241.0/28`；runner 监听 `172.31.241.1:7310` |
| 模型 API | `https://ai.example.com/v1`，Responses 协议 |

Go 代理只在服务端注入 runner 服务认证与当前管理员 ID，不转发浏览器 Cookie、Authorization 或自行提交的管理员 ID。runner 拒绝直接浏览器来源请求，不提供公开 CORS 控制接口。

runner 以 root systemd 服务管理 Docker；服务配置文件系统只读保护、隐藏宿主 home、私有临时目录，只允许工作台数据目录写入，另有 768 MiB 内存及 150% CPU 上限。项目执行在非 root 容器中，不能把整套服务称为所有进程均无 root 权限。

| 配置键 | 当前配置或默认值 |
| --- | --- |
| `CODEX_RUNNER_URL` | New API 使用的私有 runner 地址 |
| `CODEX_RUNNER_KEY_FILE` | 双方服务认证文件；也支持 `CODEX_RUNNER_KEY` |
| `CODEX_RUNNER_DATA_DIR` | `/var/lib/new-api-codex` |
| `CODEX_RUNNER_HOST` / `CODEX_RUNNER_PORT` | `172.31.241.1` / `7310` |
| `CODEX_WORKER_IMAGE` | 默认 `new-api:codex-user-environment-0.160.0`，实际部署以服务配置为准 |
| `CODEX_WORKER_NETWORK` | `new-api-codex-workers` |
| `CODEX_API_BASE_URL` | 站点 `/v1` |
| `CODEX_API_KEY_FILE` | `/etc/new-api-codex/model.key`；也支持 `CODEX_API_KEY` |
| `CODEX_MODELS` | `gpt-6.1-sol,gpt-6-astra,gpt-5.6-sol` |
| `CODEX_DEFAULT_MODEL` | `gpt-6.1-sol` |
| `CODEX_EFFORTS` / `CODEX_DEFAULT_EFFORT` | `low,medium,high,xhigh,max,ultra` / `medium`；每个模型只展示原生支持的档位。发布工具默认写入完整档位，可用 `--efforts` 显式限制 |
| `CODEX_MAX_ACTIVE` | 全局运行环境及活动任务容量，默认 2，可配置 1–8；手动启动同样占用容量，每用户始终最多 1 个任务 |
| `CODEX_MAX_WORKSPACES` | 每用户项目数，含归档；默认 40，可配置 1–1000 |
| `CODEX_IDLE_SECONDS` | 个人环境空闲停止时长，默认 600 秒，可配置 30–86400 |
| `CODEX_WORKER_CPU_PERCENT` | 个人环境占宿主 CPU 的比例，默认 5% |
| `CODEX_WORKER_MEMORY_MB` | 个人环境内存固定额度，默认 2048 MB，范围 256–1048576；每 MB 按 1024² 字节计，账号配置可覆盖 |

表中静态模型配置是 runner 的兼容配置示例，网页可用模型和分组来自 `/api/codex/catalog`，按当前管理员权限筛选；网页任务通过绑定当前登录会话的模型凭据计费。模型列表只代表允许请求，不保证每个上游或每种推理强度一直可用。当前 runner 的 configured/availability 仍检查静态模型服务配置和本地 Docker，因此有 SSH 连接不等于可绕过全局服务不可用状态；以实际状态错误为准。

## 管理员 API

所有路径以下以 `/api/codex` 为前缀。为保持现有项目和客户端兼容，项目 API 的路径仍叫 `workspaces`；这不表示每个项目拥有独立容器。JSON 成功响应通常为 `{"success":true,"data":...}`，失败为 `{"success":false,"code":"...","message":"..."}`；导出返回 ZIP 附件。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /status` | 服务是否可用、版本、模型、默认参数和限制 |
| `GET /catalog` | 当前管理员允许使用的分组、模型和默认选项 |
| `GET /github` | GitHub 开发授权状态 |
| `POST /github/authorize`、`POST /github/callback` | 开始并完成当前浏览器的 GitHub OAuth |
| `DELETE /github` | 断开 GitHub、停止供应凭据并清理执行进程 |
| `GET /github/repositories` | 分页读取授权可访问仓库 |
| `POST /ssh/probe` | 探测远端 SSH 主机指纹 |
| `GET /ssh/connections`、`POST /ssh/connections` | 列出或创建当前管理员的 SSH 连接 |
| `DELETE /ssh/connections/:id`、`POST /ssh/connections/:id/test` | 删除或测试当前管理员的 SSH 连接 |
| `GET /environment` | 当前用户个人环境状态、活动项目和资源限制 |
| `POST /environment/start` | 启动当前用户环境；请求 `{}`，不发送模型任务 |
| `POST /environment/stop` | 休眠当前用户空闲环境；请求 `{}`，保留项目与会话 |
| `GET /workspaces` | 当前用户的全部项目，含归档 |
| `POST /workspaces` | 创建项目，必填 `name`，可选 `repositoryUrl` / `branch`，或 `remote` SSH 配置 |
| `GET /workspaces/:id` | 项目、会话快照、待确认请求与事件游标 |
| `PATCH /workspaces/:id` | 重命名、归档或恢复项目 |
| `DELETE /workspaces/:id` | 删除当前用户的单个项目，不删除个人环境和其他项目 |
| `GET /workspaces/:id/conversations`、`POST /workspaces/:id/conversations` | 列出或创建项目内会话 |
| `PATCH /workspaces/:id/conversations/:conversationId` | 重命名、归档或恢复会话 |
| `DELETE /workspaces/:id/conversations/:conversationId` | 删除会话并保留项目文件 |
| `DELETE /workspaces/:id/queue/:requestId` | 取消待发消息 |
| `DELETE /workspaces/:id/turns/:turnId/messages/:role` | 隐藏对应 user/assistant 消息；不等于删除原生线程上下文 |
| `POST /workspaces/:id/turns` | 用 `prompt/model/group/effort/mode/requestId` 提交任务，可选 `busyAction: queue/interrupt` |
| `POST /workspaces/:id/interrupt` | 停止该项目任务，保留已获得内容 |
| `POST /workspaces/:id/approvals/:requestId` | 处理确认或填写 Codex 问题 |
| `GET /workspaces/:id/events?after=N` | 读取新事件，`reset` 时重新获取详情 |
| `GET /workspaces/:id/files?path=...` | 当前项目目录列表 |
| `GET /workspaces/:id/file?path=...` | 读取 UTF-8 内容及哈希 |
| `PUT /workspaces/:id/file` | 使用 `expectedHash` 保存，`null` 仅新建不存在文件 |
| `GET /workspaces/:id/diff` | 基线差异、变更文件和截断标记 |
| `POST /workspaces/:id/import` | multipart 的 `file` 字段上传 ZIP |
| `POST /workspaces/:id/upload?path=...` | application/octet-stream 上传单文件 |
| `GET /workspaces/:id/export` | 当前项目 ZIP |

详情、轮次、事件、审批、中断和排队等会话相关操作通过 `?conversation=<UUID>` 指定会话；省略时选择项目默认会话。新旧客户端不能用项目 ID 猜测当前会话 ID。

环境成功响应中 `data.environment` 包含：

```json
{
  "status": "running",
  "mode": "code",
  "activeWorkspaceId": null,
  "activeWorkspaceName": null,
  "projectCount": 2,
  "idleSeconds": 600,
  "limits": {
    "cpus": 2,
    "memoryBytes": 2147483648,
    "diskBytes": 2147483648
  }
}
```

出错时还可能有 `lastError`。接口不接受其他用户 ID、容器名或任意 Docker 参数。网页约每 5 秒独立轮询环境状态，不必先选择项目或产生一次模型调用。单纯状态轮询不延长环境空闲时间，因此开着页面不等于阻止自动休眠。空闲环境处于错误状态时，可通过休眠清理后重新启动恢复。

`409` 表示环境被任务占用、文件版本冲突、请求编号内容不一致或过期审批等；`413` 表示内容超限；`429` 表示全局运行环境或活动任务容量已满；`503` 表示未配置或运行环境不可用；`507` 表示保存或存储空间故障。跨管理员的项目统一视为不存在，不泄露项目细节。

## 升级、备份与回滚

成套构建与发布流程见 [发布说明](RELEASE.zh-CN.md)。备份应覆盖应用数据库、Runner 配置及整个数据目录，并保存程序、镜像和文件权限。项目 ZIP 与会话导出不包含用户 home、依赖缓存和服务配置，不能替代完整备份。

维护前等待全部会话、待审批和排队消息结束；不要用历史数据快照覆盖已产生的新任务。回滚应使用对应发布包的事务记录，并核对应用与 Runner 版本兼容性。

## 文档与参考

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [公开源码与私有配置](../open-source-security.zh-CN.md)

## Codex 管理与订阅试运行

管理员从侧边栏「Codex 管理」（`/codex-admin`）集中查看开通状态、权限来源、套餐到期时间和资源配置。普通管理员仅能查看和配置低于自身角色的用户；Root 可管理所有用户。用户管理的旧 Codex 弹窗入口已迁移，旧配置接口保留兼容。

订阅计划可开启「包含在线 Codex」，配置 Docker / SSH、CPU 百分比、内存 MB、磁盘 MiB、项目数、空闲超时，以及默认模型、分组和思考强度。数值为 0 表示使用服务器默认值。默认模型和分组不额外授予模型权限，模型费用继续按现有计费规则处理。

权限按请求读取有效订阅：状态 active、开始时间已到且未到期；多份套餐使用最近开始的有效 Codex 套餐，同一开始时间按订阅 ID 倒序选择。用户单独配置优先，恢复默认后继承套餐；没有套餐时沿用原有管理员默认权限。账号禁用始终禁止访问。套餐下架仅停止销售，取消订阅或到期才撤销该套餐授权；管理员关闭套餐中的 Codex 权益会对有效订阅生效。撤销后若仍有其他有效 Codex 套餐，则回退到该套餐。显式手动开通不随套餐到期失效。

资源修改在环境下次启动时生效。已有运行中的命令不会因修改套餐立即终止；后续工作台请求与模型请求重新检查权限。用户工程文件保留。上线不自动给现有普通用户开通，也不自动创建收费套餐。

数据库迁移增加可空 TEXT 列 `subscription_plans.codex_config`；旧套餐为空，因此不改变已有权益。升级前应备份数据库。旧版本回滚可保留此列，但旧版本不识别套餐 Codex 权益。
