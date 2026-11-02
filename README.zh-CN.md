# Respire for DeepSeek Harness

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/icon-respire-ai-memory.svg">
    <img src="docs/icon-respire-ai-memory-light.svg" alt="Respire AI 记忆图标" width="112">
  </picture>
</p>

[English](README.md) | 简体中文

**npm 包：[@rsrsai/dsh](https://www.npmjs.com/package/@rsrsai/dsh)**

## 让 AI 安装：复制这段提示词

将下面整段发送给 **DeepSeek Harness 内的助手**：

```text
请在我的 DeepSeek Harness 当前 profile 安装 Respire 记忆插件 @rsrsai/dsh。
先阅读并遵循 https://github.com/risense-ai/respire-dsh/blob/main/README.zh-CN.md，
然后实际执行安装，不要只解释步骤。

检查 Node.js 24+、Harness 兼容性（已验证版本为 0.2.1-rc.5）和 plugin_manager 是否可用。
复用现有 rsrs 环境；仅在缺失时，在该 profile 的执行环境中运行 npm install -g rsrs-cli@latest。
运行 rsrs --version 和 rsrs --client-only status --json。
若需要登录、解锁记忆库、配置模型或处理宿主 runtime，请指出具体待办，让我在 rsrs 中完成；
不要在聊天中索取秘密，也不要自行管理 runtime。

先检查已安装组合包。若有旧包 @rsrsai/respire-dsh，通过插件管理先停用并移除旧组合包，
再安装替代包；管理器要求停止或重启 profile 时，先告诉我所需操作。
保留记忆库、账号、rsrs 配置和无关插件。若新包已存在，避免重复安装。

调用 plugin_manager，参数为 {"action":"install_bundle","target":"@rsrsai/dsh"}。
安装 npm 组合包，不使用 Git 依赖，也不能仅在终端 npm install 就算完成。
确认只有一条已启用的 respire-memory，来源为 @rsrsai/dsh。
告诉我何时重启 Harness，然后在新对话中验证召回。
先向我要一条无敏感内容的测试事实，再验证存储及其实际记录；
在另一个召回成功且未显式存储成功的回合验证收尾提醒。
最后报告安装版本、实际执行的检查和仍需我完成的操作。未实际观察到完整链路前，不要声称已验通。

安装验通后，请主动提出配置基于插件市场的更新：在 Harness 中启用「自定义插件市场」，
添加索引源 https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json，
并确认「发现」页的 Respire 卡片显示已装版本。未经我确认，不要安装任何更新。
```

## 中文安装

需要 Node.js 24+、DeepSeek Harness **0.2.1-rc.5** 和已安装的 `rsrs`。
插件从 npm 安装到 Harness 当前 profile，通过组合包配置启用。

### 1. 准备 Respire 引擎

如果尚未安装 `rsrs`，先在终端执行：

```sh
npm install -g rsrs-cli@latest
rsrs --version
rsrs --client-only status --json
```

通过 `rsrs` 的交互流程完成账号配置、解锁记忆库，并确保宿主 runtime 正在运行。
已有可用的 `rsrs` 环境可跳过此步。

### 2. 在 Harness 中安装 npm 组合包

把下面这句话发给 **Harness 内的助手**：

```text
请使用 plugin_manager 的 install_bundle 安装 npm 组合包 @rsrsai/dsh，并确认 respire-memory 已启用。
```

对应工具参数如下；需要固定版本时将 `target` 改为 `@rsrsai/dsh@0.1.3`：

```json
{
  "action": "install_bundle",
  "target": "@rsrsai/dsh"
}
```

这里的 `@rsrsai/cli` 是引擎，`@rsrsai/dsh` 是 Harness 插件。
仅在普通终端运行 `npm install @rsrsai/dsh` 不会自动将插件接入 Harness profile。

### 3. 从之前的 Git 安装迁移

如果已安装旧组合包 `@rsrsai/respire-dsh`，先在 Harness 插件管理中移除旧组合包，
再按上面的步骤安装 `@rsrsai/dsh`。若提示仍在使用，先停用旧组合包再移除；
若管理器要求停止 profile，则按其提示停止后再操作。
保留现有记忆库、账号和 `rsrs` 配置，无需重新创建。

安装完成后重启 Harness，在插件管理中确认只有一条 `respire-memory`，
来源为 `@rsrsai/dsh` 且已启用。npm 安装与模块加载已验证；桌面完整对话链路尚未验收。

## 通过插件市场更新

npm registry 仍是版本来源；此外，本仓库发布 DeepSeek Harness 插件市场索引（format 1），
由 `scripts/market-index.mjs` 从 npm registry 生成，每次打 tag 发版后由 release 工作流自动刷新：

- `https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json`
- GitHub 不可达时的镜像：`https://cdn.jsdelivr.net/gh/risense-ai/respire-dsh@market-index/marketplace.json`

索引发布在专用的 `market-index` 分支：仓库为 `main` 配了要求 PR 的规则集，发版工作流无法直接提交到 main。
索引列出所有已发布、既非预发布也未被弃用的版本，固定 npm registry，图标用同源相对路径，
分支副本自足。Harness 使用前会校验索引，其内容视为第三方内容。jsDelivr 是第三方 CDN，可能滞后于
raw 地址，以 raw 为准。

该分支是生成物：每次刷新都 force-push 一个单提交，没有可审阅的历史；要看来源请审
`scripts/market-index.mjs` 与 npm registry。维护者可用 **Market index** 工作流（手动触发或每周定时）
或打 tag 发版来刷新。

### 配置市场更新

1. 在 Harness 打开 **插件**，在 **实验性插件** 旁点 **更多**，启用 **自定义插件市场**；随后出现 **发现** 页。
2. 在 **发现** 页选择 **添加索引源**，粘贴上面的 URL。
3. Respire 卡片会列出已发布版本；当最新兼容版本高于已装版本时，卡片标记 **有可用更新**。
   索引只在打开或刷新页面时抓取并缓存 10 分钟，后台不轮询。
4. 安装：打开条目的版本列表，选择 **安装**。第三方条目没有「一键更新」按钮——
   安装新版本会先移除旧组合包再装新包，管理器完成后需重启 Harness；重启前运行中的进程仍持有旧模块。
5. 重启后核验：插件页或 `dsh plugin --profile <profile> list` 显示新版本，profile 的
   `package.json` 精确固定该版本。

需要固定版本时运行 `dsh plugin --profile <profile> add @rsrsai/dsh@<版本号> --save-exact`
（desktop profile 须用随包 CLI）；回滚同理，换成上一个版本。若坏版本导致 Harness 起不来，
先退出 Harness（桌面进程独占 profile），用随包 CLI 执行命令后重启。
撤回已发布版本先用 `npm deprecate @rsrsai/dsh@<版本号>` 弃用；下一次索引刷新
（下一个 tag 发版、**Market index** 工作流，或运行 `node scripts/market-index.mjs` 后执行
`bash scripts/publish-market-index.sh`）会将其移除。

插件不会自行更新，也不会自行改动 Harness profile。Harness 插件管理执行安装/更新时会弹确认框；
`dsh plugin` CLI 只执行你输入的命令。

### 让 AI 配置更新

把下面整段发给 **Harness 内的助手**：

```text
请为 Respire 记忆插件 @rsrsai/dsh 配置基于插件市场的更新检查。

1. 读取 Harness 版本、profile 名称，以及 profile 的 package.json 中已装的 @rsrsai/dsh 版本。
2. 若自定义插件市场未开启，启用之：插件 → 更多（实验性插件）→ 自定义插件市场。
3. 添加插件市场索引源
   https://raw.githubusercontent.com/risense-ai/respire-dsh/market-index/marketplace.json
   若 raw.githubusercontent.com 不可达，改用
   https://cdn.jsdelivr.net/gh/risense-ai/respire-dsh@market-index/marketplace.json
4. 打开「发现」页，确认 Respire 卡片能加载，并显示已装版本或有可用更新；
   把看到的版本列表报给我。
5. 先不要安装或改动任何东西。告诉我：已装版本、最新兼容版本、你准备执行的步骤。
   我确认后，再安装该版本（第三方条目会先移除旧组合包），并告诉我何时重启 Harness；
   重启后核验已装版本。
```

## 概述

DeepSeek Harness 原生 TypeScript 记忆插件。通过 `systemPrompt.section` 注册固定规则，
通过 `agent/pre-step` 召回，通过 `agent/turn-stopping` 提醒整理新结论。
存储、判重、加密、模型推理、账号和同步由 Respire（`rsrs`）负责。

## 安装环境与本地开发

插件使用标准桌面 profile 已提供的 `agents`、`systemPrompt`、`subprocess` 和
`workingDirectory` 服务。其他 Harness 版本尚未验证。

需要时单独安装引擎：

```sh
npm install -g rsrs-cli@latest
rsrs --version
rsrs --client-only status --json
```

通过 CLI 自身的交互流程配置账号、解锁记忆库并安装可选语义模型。
插件不安装软件、不收集密码、不启动 runtime、不改账号配置。
所有调用都使用 `rsrs --client-only`，宿主 runtime 须已运行。

在 Harness 中让助手调用 `plugin_manager`：

```json
{
  "action": "install_bundle",
  "target": "@rsrsai/dsh"
}
```

本地开发时，将 `target` 设为本仓库的绝对目录。
Git 和发布归档均包含编译后的 `lib/`，安装不需要构建脚本。
替换已安装版本后重启 Harness；固定版本可使用 `@rsrsai/dsh@0.1.3`。

## 行为

| 触发 | 结果 |
| --- | --- |
| 每个运行中的 agent 首次接受用户输入 | 检查引擎状态，按实际情况提示 runtime 未运行、库锁定、会话缺失或记忆较少 |
| 接受用户消息 | `recall --titles --json`；最多 5 条标题注入同一模型步骤 |
| `记：`、`存：`、`记录：`、`记住：`、`remember:` | 不发送写入，留下 pending；主模型本轮读政策和候选，按改＞已授权的并＞挂＞存处理 |
| `/nomem` 或 `#nomem` 后接空白或输入结束 | 跳过本条自动召回，状态与收尾检查仍启用 |
| `$skill: name` 前缀 | 从召回查询中去除技能选择器 |
| 自然结束 | 每个 agent/回合最多提醒一次；前缀 pending 不会阻止收尾核查；已存内容不得重复写入 |

仅人类消息（`source.kind === 'user'`）触发查存。插件上下文、工具循环和提醒续跑不会触发。
同一回合重复接受同一消息 ID 时忽略；内容相同的新消息仍会处理。
下游拒绝和取消会阻止新操作。取消或超时的写入为**未确认**，可能已提交，不自动重试。

前缀只留下 pending 请求，钩子不会发送写入。主模型须在本轮通过 rsrs CLI
完成整理：读取 `prompt` 和 `agent-config`，检索同题候选，并用 `show` 阅读完整
正文，然后依次考虑更新、已授权的合并、挂靠和新存。新建 important 条目前，
须查看 `taxonomy --list` 或 `tree`，并用 `show` 阅读合理父节点，再用完整 ID
传入 `--parent`。找不到合理父节点时保持 pending，不猜父、不强制落根、不降级
为 trivial 绕过要求。只保存所述事实，不执行事实中描述的工程任务。
实际写入后用 `show` 回读。实际写入结果未知时禁止自动重试或声称成功；须先只读核实，核实本身不授权自动重试；
钩子的 pending 状态不会禁止首次合规写入。

收尾提醒要求助手评估新事实，不会自动归档整段对话，也不保证模型会存储结论。

## 配置

在用户 Harness patch 层覆盖已安装的配置行。匹配行的 `config` 整体替换；
未指定的插件字段使用默认值。

```yaml
- id: respire-memory
  config:
    enabled: true
    rsrsPath: rsrs
    recallLimit: 5
    recallThreshold: 0
    budgetChars: 1500
    minPromptChars: 2
    storeNudgeEvery: 1
    timeoutMs: 20000
```

`rsrsPath` 是可执行文件名或绝对路径，不是 shell 命令。
`storeNudgeEvery: 0` 关闭提醒；`N` 表示每个运行中的 agent 每 N 个含用户消息的回合检查一次。
切换 profile 或重载插件会重置临时提醒状态。召回严格限字符数，存储回执保持完整。

## 隐私与失败处理

- 召回结果与存储回执成为持久化、模型可见的 Harness 消息，可能发送给配置的模型服务。
  本地加密不会阻止模型服务读取已注入的上下文。
- 查存前拒绝常见凭据模式，但这不是完整秘密扫描器。输入前去除秘密，记忆只保留安全用途或位置引用。
- 日志只含操作或错误类别，不含提示词、记忆正文、原始 CLI 错误和凭据。不向库写入插件自有文件。
- 引擎失败给出有限长度提示，原任务继续。Windows 用 JSON stdin 向常量 PowerShell 脚本传参，
  POSIX 直接传参，均不把用户文本拼入 shell 源码。
- 通过 Harness subprocess provider 在助手已核验的工作目录运行。
  `rsrs` 与 runtime 的安装位置取决于执行环境，远程 profile 也须按此配置。

## 开发与发布

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm pack
```

测试使用真实 Cordis 事件分发与受控 subprocess 服务，不写用户记忆库。
生产目标为已发布的 Harness 0.2.1-rc.5 API，`package-lock.json` 锁定验证依赖。

CI 在 Linux、macOS 和 Windows 执行类型检查、构建、测试、发布包检查与生成文件一致性检查。
发布时更新 `package.json` 和 lockfile，重新构建并提交 `lib/`，再推送 `v<package version>`。
发布工作流先复用完整 CI 矩阵，再将 `@rsrsai/dsh` 发布至 npm，附带 provenance；
相同 `.tgz` 与 SHA-256 校验文件上传 GitHub Releases。
正式版使用 `latest`，预发布使用 `next`；普通 main/PR 推送不发布。

npm 发布使用 GitHub OIDC，无需保存 npm token。首次登录发布后，配置包的 Trusted Publisher：
owner 为 `risense-ai`，仓库为 `respire-dsh`，工作流为 `release.yml`，允许 `npm publish`，
environment 留空。工作流需要 `id-token: write` 和 GitHub 托管 runner。

## 参考

- [respire-dimcode](https://github.com/risense-ai/respire-dimcode)：行为参考。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主 API。

插件图标为单个自适应 SVG：默认显示亮色变体，当 Harness 主题要求暗色配色时
切换为暗色变体。独立的亮色与暗色变体存放在 `docs/` 下。图标为原创作品，
按本仓库 MIT 许可证分发。

## 工具执行前的记忆写入检查

插件会在工具执行前检查能识别的 rsrs 写命令。important remember 缺少父节点、
父节点为空或包含 force 时，插件会拒绝执行。merge-ids 即使标为 trivial，
也必须显式提供父节点，因为合并可能继承重要性。
非空的字面父节点 ID 必须通过只读 `rsrs --client-only show <id> --json` 确认存在。
验证失败、取消或超时后保持 pending，原 shell 命令不会执行。检查使用已配置的引擎，
不启动 runtime；父节点检查限时五秒，为反馈和清理保留时间。

执行 update --importance important 前，先读取目标的当前 parent_id，再用 show
确认父节点存在。目标没有有效父节点时拒绝提升，须先挂到真实父节点。当前 CLI 的
update 未公开改父节点参数；插件会拒绝这些不支持的参数，不把它们描述成能实际改父的命令。

已知 memory_remember、memory_update 工具名（含服务器命名空间）无法绑定到当前 CLI 的目标库，因此直接拒绝。必须改用受保护的 CLI 工具；不得自动重试先前结果未知的写入。其他工具名不受影响。
此检查无法把不透明的哈希或截断名称还原成 MCP 原始工具名。

对已知 shell 的 -c/-Command 代码参数和生效的命令替换，只识别写入并拒绝整个调用，不执行代码。简单的 NAME=value 前缀不能隐藏写入。没有展开的普通引号文本仍按文本处理。检查区分 Bash 和 PowerShell 的转义；terminal_send 的持久 shell 不明确，因此采用保守检查。

正常读取与其他工具不变，当前 remember/update 的元数据参数仍可使用。
已识别的复合写命令、命令替换、包装调用或动态参数会被拒绝，须改成一条参数明确的命令。
正文里的 `--parent` 不会被当作参数。此检查不是 shell 沙箱，不能覆盖任意脚本、
别名、隐藏的执行文件或分段终端输入。插件不授予权限、不选父节点、不代写、不授权自动重试。
模型仍必须读策略与候选全文、判断合理父节点、遵守只读和关闭状态，并核验实际写入。
实际写入结果未知时，不得自动重试或声称成功。

覆盖 Harness 的 bash、pwsh 和 terminal_send 文本，包括嵌套调用。
异步检查后还有同步 guard，后续 allow 不能取消拒绝，也不能把旧验证用于新参数。
宿主须支持 tools.guard()，本次核对版本为 0.2.1-rc.5。不兼容宿主会在插件加载时报告错误。
enabled: false 会同时关闭记忆集成与此检查。

检查针对经过硬门的参数。其他扩展若在硬门后替换参数，或绕过宿主工具链直接执行，
不在此检查范围内。CLI/Core 仍须在实际写入时原子地保证父节点约束。
