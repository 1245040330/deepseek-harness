# 文件转换正文查询插件

在宿主仓库启用：

```sh
pnpm dsh web --patch plugins/clinfo-document-text/cordis.patch.yml
```

工具 `get_document_text_by_file_url` 接受必填字符串 `fileUrl`，向配置的接口发送 GET 请求。使用 URLSearchParams 编码完整文件地址，保留其中的中文、查询参数与签名，不下载或转换文件。

调用示例：

```text
请优先调用 get_document_text_by_file_url，fileUrl 使用我提供的完整文件地址，获取正文后总结；如果返回 fallback，请自行读取或转换原始文件。
```

工具返回 JSON 字符串：

- 成功：`{"status":"success","extractedText":"原始 Markdown 正文"}`。仅使用接口 `code: 200` 下的 `data.extractedText`，保留原始空白与 Markdown，不返回其他业务字段，也不解析 `extractRawJson`。
- 回退：`{"status":"fallback","reason":"原因","nextAction":"提示智能体自行处理原始文件"}`。包括无记录、缺失或空白正文、业务错误、HTTP 错误、无效 JSON、网络异常和请求超时。

空参数报告工具错误；用户取消直接传播取消，不触发文件处理。请求默认 30 秒超时，工具执行期限额外预留 5 秒用于返回回退结果。

优先查询与后续自行处理通过工具说明交给智能体执行，本插件不拦截其他工具、不强制全局调用顺序，也不新增文件转换能力。应确保当前智能体已有可用的文件处理能力。支持业务登录插件通过 `agentInfo.pluginList` 中的插件 ID `clinfo-document-text` 自动加载。

独立逻辑测试无需安装依赖（Node.js 22.18+）：

```sh
node --test plugins/clinfo-document-text/query.spec.mjs
```

测试使用模拟网络；宿主工具注册及聊天中的调用顺序需在实际宿主中验证。本目录由用户自行拷贝到宿主项目，不自动同步。
