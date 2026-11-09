# DeepSeek Harness 修复报告

[English](FIXES.md) | 中文

本公开社区仓库在同一条 `main` 主分支集中提供三个后端修复及回归测试，包含完整上游源码，并保留[MIT 许可证](LICENSE)及[第三方声明](THIRD_PARTY_NOTICES.md)。这些修改尚不属于上游正式版本。

## 来源与范围

源码基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `0.2.2-rc.1` 版本，基础提交为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本地初始导入保留源码快照，并不声称保留上游提交图。三个原始独立修复提交仍保存在 [kernelvale/deepseek-harness](https://github.com/kernelvale/deepseek-harness)。

| 修复 | 触发条件 | 用户可见问题 | 修复后行为 |
|---|---|---|---|
| 继承收件箱的任务归属 | 继承前缀包含父任务入队，却不包含后续领取 | 子代理先执行父任务，再执行委派任务 | 新委派以持久事件清除继承的待处理输入 |
| 委派模型选择 | 新子级捕获模型 B，继承选择仍为 A | 实际请求使用 A，与新配置不符 | 子级在继承前缀之后记录本次模型选择 |
| 正常结束期间唤醒 | 唤醒输入在最后一次空队列检查后、进入空闲前到达 | 输入滞留，直到另一次唤醒才运行 | 正在结束的驱动登记一次后续启动 |

前两个问题在所述历史及配置条件满足时稳定触发。第三个问题在精确控制微任务窗口时稳定复现，自然使用中的出现频率尚未统计。这些是本地复现结论，并非线上事故实测声明。

## 1. 分叉子代理重放父级排队任务

### 复现与影响

1. 父代理处理任务 A 期间，将任务 B 加入队列。
2. A 完成后，父代理领取 B，开始下一轮。
3. 该轮尚未完成时，创建继承历史的分叉子代理，委派任务 C。
4. 分叉只复制父级已完成轮次；复制前缀包含 B 入队，却不包含当前轮次中的 B 领取。

修复前，子代理把 B 恢复成自己的待处理输入，先请求执行 B 再执行 C。用户可能遇到重复工作、偏离委派目标的答案、额外模型调用；如果 B 要求修改数据，还可能发生重复工具副作用。复现直接证明了模型输入重放；破坏性副作用属于基于代码的后果推断，没有针对外部系统执行。

### 原因与修复

持久收件箱投影把继承的队列事件恢复为子级工作。[子代理管理器](packages/subagent/subagent/src/manager.ts)现在从继承的入队事件收集消息标识，在发布新子级前，移除两个子级待处理队列中仍匹配的消息。删除使用普通子会话事件记录，恢复时仍然有效。父日志、父队列、新追加的子上下文、普通 Session 分叉及已有子级的冷恢复各自保留原有语义。

历史关联为引入持久收件箱投影的 [aaf50dc39adc](https://github.com/deepseek-ai/deepseek-harness/commit/aaf50dc39adcad8c34e4909b7d8d9c5dd9fcd874)，以及 PR #2672 的合并提交 [b0a7d2ce3b4c](https://github.com/deepseek-ai/deepseek-harness/commit/b0a7d2ce3b4c19d7452e364b2d7acbfa87e707ed)。后续 PR #2746 将 Web 队列继续统一到该投影。这些关联来自代码差异追溯，尚未通过完整历史二分确认最早引入提交。

验收见[任务归属回归](packages/subagent/subagent/tests/fork-inherited-inbox.spec.ts)和[正式启动组合回放](snapshots/session/fork-inherited-inbox/snapshot.yml)。此前独立对照中，未修复基线的两个新增场景均失败，修复后通过。原始独立修复：[932466e987fd](https://github.com/kernelvale/deepseek-harness/commit/932466e987fd62c945192790c8fcba46cee7c68e)。

## 2. 子级捕获的模型被继承状态覆盖

### 复现与影响

一种触发是父级完成历史选择 A，本次分叉子级显式指定 B。另一种是父级在当前尚未完成轮次切换到 B，此时创建默认分叉子级，但已完成前缀仍选择 A。同一模型下显式清除推理等级，也可能被旧继承选择覆盖。

修复前，子级创建配置和实际模型请求不一致，可能影响能力、延迟、费用及推理行为；跨服务商时，如果旧路由不可用，还可能意外请求失败。实际路由不匹配已在本地复现，没有声称发生真实模型账单或服务可用性事故。

### 原因与修复

会话模型选择状态的优先级高于创建选项。[子代理管理器](packages/subagent/subagent/src/manager.ts)现在在发布带继承内容的新子级前，将捕获的服务商、模型及可选显式推理等级写入子会话；省略等级会清除旧显式选择，由适配器采用默认等级。已有子级恢复时保留自身后来保存的选择，全局选择优先级不变。

历史关联为 PR #6298 的 [b805300652a4](https://github.com/deepseek-ai/deepseek-harness/commit/b805300652a4ade0c81444dcda0af3bee103f922)，该修改把优先读取会话的模型选择提前到步骤准备之前。尚未执行完整历史二分。

验收见[模型选择回归](packages/subagent/subagent/tests/fork-model-selection.spec.ts)、[权限继承回归](packages/subagent/subagent/tests/activation-policy.spec.ts)及[模型切换回放](snapshots/session/fork-captured-model/snapshot.yml)。此前五个场景的未修复基线对照为三个失败、两个正常对照通过。回放运行器现在按各子级自身的配置和系统提示版本验收。原始独立修复：[8cbb57341a54](https://github.com/kernelvale/deepseek-harness/commit/8cbb57341a5402cdc3fc31786cefdd5468e5bdb2)。

## 3. 正常结束交接期间丢失新消息唤醒

### 复现与影响

在驱动最后一次检查收件箱为空之后、发布空闲之前，通过微任务投递主动唤醒输入。普通排队的后续输入和供下一步使用的插入输入均可触发；正常处理过程中或驱动完全空闲后投递，不属于此窗口。

修复前，消息已被接受并留在队列，唤醒操作却认为仍在运行的驱动会领取它，而该驱动已经决定退出。用户可能看到消息似乎被忽略，直到另一次主动输入才执行；等待该排队轮次的 SDK 调用可能一直停留。输入被暂存，没有被删除。

### 原因与修复

[循环驱动](packages/core/agent-loop/src/agent.ts)在决定正常退出时设置仅存在于进程内的结束状态。此时到达的唤醒会在旧驱动收敛后启动新驱动。取消会撤销先前的后续启动，保留队列的取消继续暂存输入，取消后新到达的唤醒仍有效，仅注入上下文不启动请求。结束事件追加失败沿用既有错误处理路径。

历史关联为异步驱动交接修改 [f2e20c1ef04b](https://github.com/deepseek-ai/deepseek-harness/commit/f2e20c1ef04b27501016dabda696fe6891781489)，以及 PR #1870 的 [df30c62e2b06](https://github.com/deepseek-ai/deepseek-harness/commit/df30c62e2b062da14fa0366728d821f416d72e57)，后者增加取消期间的延后唤醒，未覆盖正常结束窗口。这些是追溯关联，并非完整历史二分结论。

验收包括[十个循环场景](packages/core/agent-loop/tests/completion-wake.spec.ts)、[无界面回放](snapshots/session/completion-wake-handoff/snapshot.yml)、[TypeScript SDK 回放](snapshots/sdk/completion-wake-handoff/snapshot.yml)和[Python SDK 验收](python/sdk/tests/test_completion_wake.py)。此前九个基线场景中三个失败、六个正常对照通过，修复后对应场景及追加的结束记录失败场景通过。原始 Python 对照只完成第一轮，按预期未通过两个轮次的断言。

SDK 第一次运行仍返回其自身输入的结果，通过显式等待再等待独立排队的后续轮次；本修复没有将第一份结果的范围扩展为后续工作。原始独立修复：[1d2a2f7eab6a](https://github.com/kernelvale/deepseek-harness/commit/1d2a2f7eab6af39d6374283e922442963e9af6f3)。

## 合并版本验证

机器可读的[验证记录](validation.json)列出此合并工作区实际执行的命令和结果。第一次合并测试早于原生构建完成启动，因缺少原生系统模块而失败，不计入通过证据；回归结果来自完整构建成功后的再次执行。

| 合并工作区检查 | 结果 |
|---|---|
| 完整构建，包含聚合类型检查 | 10 项通过 |
| 相关行为回归 | 58 个文件、1,044 项测试通过 |
| 无界面 CLI 与 TypeScript SDK 回放 | 16 项通过，过滤条件外的 226 项未执行 |
| Python SDK 交接验收 | 1 项通过 |
| 文档检查 | 43 项通过 |
| 静态检查 | 退出码 0，保留一条原有的未使用禁用规则提示 |

此前逐项验证中，两个子代理修复各通过 545 项相关测试，唤醒修复通过 501 项循环测试，相关无界面回放、六个 SDK 回放、Python 验收及运行时 smoke 均通过。此前一次源码组合验收的 17 个新增场景全部通过。本仓库当前证据以验证记录中的合并工作区结果为准。

验证使用 Linux x64、Node.js 24.22.2、pnpm 11.28.5，以及脚本适配器、记录响应或本地模拟服务。没有真实模型接口、Windows、macOS、安装 wheel 或单文件打包的验证结果。本次没有增加公开协议字段、持久事件格式、命令行参数或配置项。

## 运行本仓库源码

官方 npm 包不包含本社区工作区的修改。运行本仓库请使用：

```sh
git clone https://github.com/kernelvale/deepseek-harness-fixes.git
cd deepseek-harness-fixes
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm dsh web
```

依赖条件和平台构建要求见[开发指南](docs/development.zh.md)，[安全说明](SAFETY.zh.md)同样适用。

## 上游报告

原仓库关闭了 Issues 和拉取请求，并指定通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交 bug 报告。已通过官方入口提交[上游讨论 #12727](https://github.com/deepseek-ai/deepseek-harness/discussions/12727)，发布状态同时记录在[验证记录](validation.json)中。本修复仓库的存在不代表上游已经接受或合并这些修改。
