# Custom UI copies

English | [中文](README.zh.md)

This directory contains complete local copies of the default layout, sidebar and conversation UI plugins. The initial copies contain 101 unchanged source files. The custom sidebar and additional Chat copy now contain the customization described below. The default sources and startup configuration remain unchanged.

## Editing locations

| Area | Copy | Main files |
| --- | --- | --- |
| Layout | `ui-layout` | `src/client/AppFrame.tsx`, `AppFrame.module.css` |
| Left sidebar | `ui-sidebar` | `src/client/SidebarRoot.tsx`, `SidebarRoot.module.css` |
| Chat and composer | `ui-conversation` | `src/client/skeleton/ConversationContent.tsx`, `InputBar.tsx`, associated CSS |

Workspace and right-sidebar plugins continue using their existing implementations. The sidebar hides Plugins and Scheduled Tasks and uses 金教云智能体 as its brand name. The overlay hides the Models, Built-in Plugins and Agent Presets settings UI. The copied Chat plugin comments out the work-details presentation selector, retaining the collapse-timing selector. Its default presentation is Compact in both Web and Desktop; explicit saved preferences remain unchanged. These are presentation changes; model execution, backend plugin management, scheduling and preset services remain available.

## Build and activate

Use the repository-supported Node.js version (Node 24 recommended), with the original dependencies and build outputs available. Run at the repository root:

```sh
node packages/client/ui-custom/build.mjs
pnpm dsh web --patch packages/client/ui-custom/cordis.patch.yml
```

The build script links each copy to its default package's installed dependencies, compiles TypeScript, and builds its Host and browser bundles without installing dependencies or changing lockfiles. Rebuild after editing a copy and restart the service. Nested copies are excluded from the ordinary root package build; build them separately.

The overlay disables the three default UI entries for that launch and inserts the copied implementations under `ui-custom-*` entry IDs. It does not save changes to the default profile. Existing custom settings on the default entries must be supplied explicitly on their corresponding copied entries. The copies retain the original package names and browser module IDs so existing plugin dependencies continue resolving. These private copies are alternative implementations, not independently publishable npm packages. Never activate both implementations of a UI package simultaneously.

Business login supplies `agentInfo.sysPrompt`, `name`, `model` and `pluginList`. The business login plugin configures the current chat, loads the listed local plugins, and injects `defaultContext`; no separate tool-list API or manual loading command is used. Model selection UI is hidden. The supplied model must uniquely match a configured provider catalog.

To return to the default UI, restart without the custom UI overlay. Conversation data is unaffected.

## Verification

```sh
node packages/client/ui-custom/verify-copy.mjs
```

This initial-copy check compares every copied source file to its default counterpart. Differences become expected once customization begins. Before customization, initial validation included TypeScript compilation, the initial three browser bundle builds, composed profile configuration, and an isolated browser startup with the copied UI and no page exceptions. Real model responses and right-sidebar tool interactions have not been exercised.

The additional `ui-chat` copy is built by `build.mjs`. This customization has not been built or browser-tested, at the user’s request. Rebuild before starting the customized UI.
