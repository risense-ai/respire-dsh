# Respire for DeepSeek Harness

[English](README.md) | 简体中文

**npm 包：[@rsrsai/dsh](https://www.npmjs.com/package/@rsrsai/dsh)**

## 中文安装

需要 Node.js 24+、DeepSeek Harness **0.2.1-rc.2** 和已安装的 `rsrs`。
插件从 npm 安装到 Harness 当前 profile，通过组合包配置启用。

### 1. 准备 Respire 引擎

如果尚未安装 `rsrs`，先在终端执行：

```sh
npm install -g @rsrsai/cli@latest
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

对应工具参数如下；需要固定版本时将 `target` 改为 `@rsrsai/dsh@0.1.2`：

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

## 概述

DeepSeek Harness 原生 TypeScript 记忆插件。通过 `systemPrompt.section` 注册固定规则，
通过 `agent/pre-step` 召回，通过 `agent/turn-stopping` 提醒整理新结论。
存储、判重、加密、模型推理、账号和同步由 Respire（`rsrs`）负责。

## 安装环境与本地开发

插件使用标准桌面 profile 已提供的 `agents`、`systemPrompt`、`subprocess` 和
`workingDirectory` 服务。其他 Harness 版本尚未验证。

需要时单独安装引擎：

```sh
npm install -g @rsrsai/cli@latest
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
替换已安装版本后重启 Harness；固定版本可使用 `@rsrsai/dsh@0.1.2`。

## 行为

| 触发 | 结果 |
| --- | --- |
| 每个运行中的 agent 首次接受用户输入 | 检查引擎状态，按实际情况提示 runtime 未运行、库锁定、会话缺失或记忆较少 |
| 接受用户消息 | `recall --titles --json`；最多 5 条标题注入同一模型步骤 |
| `记：`、`存：`、`记录：`、`记住：`、`remember:` | 尝试一次 `remember`，注入成功、待决或失败回执 |
| `/nomem` 或 `#nomem` 后接空白或输入结束 | 跳过本条自动召回，状态与收尾检查仍启用 |
| `$skill: name` 前缀 | 从召回查询中去除技能选择器 |
| 自然结束 | 每个 agent/回合最多提醒一次；显式存储成功时不提醒 |

仅人类消息（`source.kind === 'user'`）触发查存。插件上下文、工具循环和提醒续跑不会触发。
同一回合重复接受同一消息 ID 时忽略；内容相同的新消息仍会处理。
下游拒绝和取消会阻止新操作。取消或超时的写入为**未确认**，可能已提交，不自动重试。

`pending` 表示**尚未写入**。助手须读候选，决定更新、合并或挂靠；成功须返回有效 ID。
显式存储先使用抽取的标题和 `important`，回执及规则要求助手完善标题并遵循库工作流。
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
生产目标为已发布的 Harness 0.2.1-rc.2 API，`package-lock.json` 锁定验证依赖。

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

图标为原创作品，按本仓库 MIT 许可证分发。
