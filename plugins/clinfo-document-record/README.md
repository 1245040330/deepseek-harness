# CLInfo 文档查询插件

从仓库根目录运行：

```sh
pnpm dsh web --patch plugins/clinfo-document-record/cordis.patch.yml
```

单次任务：

```sh
pnpm dsh --profile headless --patch plugins/clinfo-document-record/cordis.patch.yml "调用 query_document_records，查询 businessId 为 520403K、businessName 为 专业建设标准-国家标准 的文档，并根据返回正文总结培养目标"
```

工具的两个参数均必填，无鉴权。使用 URLSearchParams 编码中文参数。
完整接口 JSON 作为字符串返回，保留 data 中的所有记录和提取正文；PTC 中可用 JSON.parse(await tools.query_document_records({...})) 获取对象。
HTTP 错误、非 JSON、业务 code 非 200 或 data 非数组均报告工具失败；单条文档的失败状态保留为数据，不把整个查询判为失败。调用取消和配置超时由工具执行流水线传递到 fetch。
配置文件可修改 endpoint 和 timeoutMs，修改后重新启动。
这是仓库源码插件；启动需要该仓库原有的模型配置，接口本身不需要密钥。
