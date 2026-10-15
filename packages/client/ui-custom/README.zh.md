# 自定义 UI 副本

[English](README.md) | 中文

此目录完整复制默认的布局、左侧栏和聊天 UI 插件，保留展示组件、CSS、状态与输入控制代码。初次复制保留全部界面元素；当前定制如下。原插件和默认启动配置不修改；不启用本目录覆盖层时继续使用原 UI。

## 副本位置

| 区域 | 副本 | 后续定制入口 |
| --- | --- | --- |
| 整体布局 | `ui-layout` | `src/client/AppFrame.tsx`、`AppFrame.module.css` |
| 左侧栏 | `ui-sidebar` | `src/client/SidebarRoot.tsx`、`SidebarRoot.module.css` |
| 聊天与输入框 | `ui-conversation` | `src/client/skeleton/ConversationContent.tsx`、`InputBar.tsx`、对应 CSS |

右侧边栏及工作区插件继续复用原实现，均未复制或修改。当前副本隐藏左侧“插件”“自动化任务”，顶部名称改为“金教云智能体”；覆盖层隐藏设置中的“模型”“内置插件”“Agent 预设”入口。新增 `ui-chat` 副本，注释“工作步骤展示”选择项，保留“工作步骤收起时机”；Web 和 Desktop 的默认展示均为“简洁”，已有保存偏好不覆盖。模型调用、后台插件管理、自动化任务和 Agent 预设服务不改动。聊天页头及其他区域尚未删减。

## 构建和启用

在仓库根目录、使用项目支持的 Node.js 版本（推荐 Node 24），先确保原项目依赖和构建已就绪：

```sh
node packages/client/ui-custom/build.mjs
pnpm dsh web --patch packages/client/ui-custom/cordis.patch.yml
```

`build.mjs` 为副本建立指向原插件依赖目录的本地链接，编译类型并构建三个副本，不安装依赖或改写依赖锁文件。新增及修改源文件后重新运行该命令，再重启服务。副本位于嵌套目录，不会自动加入根目录的常规包构建；必须单独构建。

`cordis.patch.yml` 在本次启动中禁用默认 `ui-layout`、`ui-sidebar`、`ui-conversation` 三条配置，再插入对应的 `ui-custom-*` 副本条目，不写回默认配置。若此前给原 UI 条目设置了自定义配置，需要在覆盖层中的副本条目显式配置相同字段。副本的包名与浏览器模块标识也保留原值，让其他插件的依赖关系继续工作。副本与原版是二选一的实现，不要另行插入一组重复的 UI 条目。副本仅供本地定制，不用于独立 npm 发布。

业务登录返回的 `agentInfo.sysPrompt`、`name`、`model` 和 `pluginList` 用于配置当前聊天。业务登录插件直接加载列表中的本地插件并加入 `defaultContext`，不再查询独立的工具列表接口，也不需要手动调用加载工具。页面隐藏模型选择入口；服务端指定的模型必须在已配置的 provider 模型目录中唯一匹配。

恢复默认 UI：重新启动时去掉自定义 UI 的 `--patch` 参数即可，聊天数据不受影响。

## 验证

构建检查 TypeScript 和浏览器插件产物。`verify-copy.mjs` 核对当前副本的 `src` 文件与默认源文件是否逐一相同，仅用于首次复制验收；开始定制后出现差异是正常的。

```sh
node packages/client/ui-custom/verify-copy.mjs
```

初始验证包括 TypeScript 编译、三个浏览器插件构建、组合后的启用配置，以及隔离临时服务中的浏览器启动；页面没有运行异常。真实模型回复和右侧边栏工具交互尚未执行验证。

本次定制按用户要求未运行构建或浏览器验证；初次复制时的验证结果不代表本次定制已验证。`build.mjs` 已包含新增 `ui-chat` 副本，使用前需重新构建。
