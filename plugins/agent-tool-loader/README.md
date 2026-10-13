# Agent Tool Loader

通过用户在聊天框提供的业务 `agentId` 查询工具列表，加载同级目录中的本地插件。只新增此目录，不修改默认应用配置。

从仓库根目录启用加载器：

```sh
pnpm dsh web --patch plugins/agent-tool-loader/cordis.patch.yml
```

在聊天框输入：

```text
我的业务 agentId 是 2，请调用 load_agent_tools 加载它支持的工具。
```

加载器调用配置的 GET 接口，将 `agentId` 编码为查询参数。成功响应必须包含 `code: 200`、匹配的字符串 `data.agentId` 和 `data.plugins: [{ id }]`。插件 ID 仅允许小写英文、数字和连字符，不能是加载器自身。重复 ID 去重，加载顺序保留接口顺序。

`clinfo-document-record` 对应 `plugins/clinfo-document-record/cordis.patch.yml`，其中的 `./index.ts` 相对于该配置文件解析。`pluginsDir` 相对于加载器源码目录解析，默认配置 `..` 指向现有插件目录。接口地址和超时均在 YAML 配置中指定。

插件只挂载到调用工具的聊天 Agent，不会增加其他聊天的能力；现有预设保留。动态插件可以插入新条目，但不能覆盖预设条目；声明服务的插件需要提供隔离域。加载成功后，工具返回业务 Agent ID 和已加载插件 ID；新增工具在后续模型请求中可用。

同一聊天首次成功加载后绑定业务 Agent ID，重复调用同一 ID 复用加载结果，不重新查询；切换 ID 请新建聊天。空列表是有效结果，也会绑定该 ID。接口失败、无效响应、插件文件缺失、路径越界、加载失败或取消会报告工具失败，并清理本次挂载，之后可重试。已经成功加载的插件保留至聊天 Agent 或加载器被销毁。

不自动安装 npm 依赖，不下载远端代码，不自动监听插件文件修改。服务重启或聊天 Agent 被重新创建后，需要再次调用 `load_agent_tools`；本插件不修改聊天持久化格式。加载器不根据聊天文字自动运行，必须由模型调用工具；普通聊天中仅输入 `2` 不保证模型识别其含义。

接口读取已用真实 `agentId=2` 验证；测试使用模拟网络响应，不调用文档业务接口。

运行本目录测试：

```sh
pnpm exec vitest run --config plugins/agent-tool-loader/vitest.config.ts
```

类型检查使用已有依赖声明，不生成项目构建产物：

```sh
node plugins/agent-tool-loader/typecheck.mjs
```
