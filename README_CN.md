# paseo-plugin-zcode

[English](README.md)

[Paseo](https://paseo.sh) 的 provider 插件，把 **ZCode**（智谱 Z.ai 的编码 agent，GLM 驱动）注册为一个 agent 后端。实现方式是用 Paseo 的 `runAcpProvider()` 包装社区桥 [zcode-acp-server](https://github.com/william0wang/zcode-acp)：流式输出、编辑模式、权限确认、续话、模型与思考强度列表，全部走标准 Agent Client Protocol。ZCode 自己掌管登录、工具、模型与会话存储——你已有的账号和 GLM Coding Plan 原样沿用，Paseo 里不需要配置任何 API Key。

> **非官方集成**，与智谱 AI / Z.ai 无隶属或背书关系。

## 工作原理

```text
Paseo daemon
  └─ index.server.ts（本插件）      找到桥、找到 ZCode CLI，生成启动垫片
       └─ node <生成的垫片>         垫片负责注入 ZCODE_BIN / ZCODE_NODE
            └─ zcode-acp-server     ACP 桥（版本由本仓库锁文件钉死）
                 └─ zcode app-server 真正的 ZCode 引擎  ──▶  GLM（你的 Coding Plan）
```

插件本身不含 UI，也不含协议代码。执行 `paseo plugin add` / `update` 时，manifest 的 `build` 会在托管检出目录里跑 `npm ci --omit=dev`，装上仓库钉定的桥版本。随后插件定位这份拷贝（优先检出内副本，其次常见全局根目录），解析出 ZCode CLI，注册 provider `zcode`。

## 它给 Paseo 带来什么

- 一个 **`zcode` provider**：流式输出、编辑模式（Plan / Build / Edit / Guarded / Yolo）、权限确认、续话、模型与思考强度列表，全走标准 Agent Client Protocol。
- 一个 **GLM Coding Plan 用量卡**：插件向 Paseo 注册用量源（「用量」界面和 `paseo usage` 可见），读同一份 `~/.zcode/v2/config.json` 凭证、直接查官方配额接口，不额外起桥进程。标准 Coding Plan 账号显示 5 小时、每周、MCP 三个窗口及重置时间；当前激活 provider 不是官方 Plan（网关、自定义端点、升级后无密钥的 Plan）时优雅降级为 `unavailable`，不瞎猜。

## 前置条件

| 条件 | 说明 |
| --- | --- |
| daemon 上 Paseo ≥ 0.11.0 | provider 插件 API（`status`、`getCatalogCacheKey`、`registerUsageSource`）；本插件在 0.12.x 上实测 |
| daemon 主机 Node.js ≥ 22 | 桥依赖 `node:sqlite`；插件会实测探测可用 node，绝不会选中 Electron 托管的 daemon 二进制 |
| 已安装并登录 ZCode | 桌面 App 或 CLI（≥ 0.14.8；0.16+ 全线支持）；凭证读自 `~/.zcode/v2/config.json` |
| 开启插件功能 | `~/.paseo/config.json` 根级写 `"pluginsEnabled": true`，然后 `paseo reload` |
| daemon 主机可用 npm 且能联网 | `add`/`update` 时需要它安装桥 |

## 安装

已上架 Paseo 官方插件注册表，id 为 [`lianxin255/zcode`](https://paseo.sh/plugins)：

```bash
paseo plugin add lianxin255/zcode
paseo plugin ls                   # 期望：paseo-plugin-zcode  running
paseo provider diagnostic zcode   # 期望：Status Ready，并列出模型
```

用仓库 URL 安装（`paseo plugin add lianxin255/paseo-plugin-zcode`）效果相同，区别是跟踪 `main` 而不是注册表审核过的钉定版本。

![Paseo 中的 ZCode 用量卡](images/zcode-usage-card.png)

之后照常派活：

```bash
paseo run --provider zcode "修复失败的测试"
```

首次运行要安装桥并预热 ZCode 的 skill/plugin 发现，所以第一个会话可能耗时一两分钟；ACP 握手窗口放宽到 180 秒。

## 升级

```bash
paseo plugin update paseo-plugin-zcode
```

该命令会重新拉取 `main`、重跑 `npm ci` 并重载插件。想跟进更新的桥版本：改本仓库 `package.json` 里的 `zcode-acp-server`、重新生成锁文件、打个 tag。全局安装的桥（`npm i -g zcode-acp-server`）作为兜底会被采纳，但检出内副本始终优先——这样桥版本与插件发布版本保持钉定。

## 配置

ZCode 装在默认位置时无需任何配置：`/Applications/ZCode.app`（macOS）、`%LOCALAPPDATA%\Programs\ZCode`（Windows），或 `PATH` 上能解析到 `.cjs`/`.js` 文件的 `zcode` 入口。非标准布局用 `~/.paseo/config.json` 的 provider 条目：

```json
{
  "agents": {
    "providers": {
      "zcode": {
        "env": { "ZCODE_BIN": "D:\\Tools\\ZCode\\resources\\glm\\zcode.cjs" }
      }
    }
  }
}
```

daemon 同样支持对桥启动做 `command` 覆盖（replace / append 两种模式）。改完记得 `paseo reload`。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `paseo plugin ls` 报 error | 看 `paseo plugin logs paseo-plugin-zcode`；通常是 Node 低于 22，或构建阶段 npm 不可用 |
| `Failed to create agent: Internal error` | ZCode backend 启动即死。先查桥日记 `~/.zcode/cli/log/zcode-acp-<date>.log`；若出现 `无法定位 CLI ZCode Built-in Provider Config`，说明插件没找到真实的 `zcode.cjs`，请设置 `agents.providers.zcode.env.ZCODE_BIN` |
| 状态提示 `zcode-acp-server was not found` | 执行 `paseo plugin update` 重装桥，或 `npm i -g zcode-acp-server` |
| 状态提示 node 版本过旧 | 在 daemon 主机装 Node ≥ 22，或用 `agents.providers.zcode.command` 指定某个 node 二进制 |
| 用量卡显示 `quota endpoint reported no limits` | 当前激活的 ZCode provider 不是官方 Coding Plan（网关/自定义端点，或升级 Plan 后无密钥）。属预期——官方配额接口查不到该账号。登录 Coding Plan 账号后卡片就会有数据 |
| 只有第一次会话特别慢 | 属正常预热（安装桥 + skill 发现） |

`paseo provider diagnostic zcode` 会显示插件实际将用于启动桥的 node 二进制与桥版本，以及 `ZCODE_BIN` 覆盖是否生效。

## 平台说明

- **macOS** —— 基准平台，已在 Paseo 0.12 上端到端实测（App 托管 daemon，多次真实会话验证：流式回合、模型发现均正常）。
- **Linux** —— 与 macOS 走完全相同的代码路径，标准安装应当可用，但**尚未在真实 Linux 机器上确认**；CLI 不在扫描根目录内时设置 `env.ZCODE_BIN`。
- **Windows** —— 代码层面已支持：生成的启动垫片不依赖 shell（任何平台都不用 `/usr/bin/env`），并会自动发现默认位置的 ZCode App bundle。**尚未在真实 Windows 机器上验证**——若遇到问题（尤其是 ZCode 子进程清理、或自定义安装路径），欢迎提 issue；把 `env.ZCODE_BIN` 指向 `zcode.cjs` 完整路径可解决绝大多数布局问题。

## 开发

- `index.server.ts` —— provider 注册：定位桥/node/ZCode CLI 并生成启动垫片。`server/usage.ts` —— GLM Coding Plan 用量源。无 client 入口，不提交构建产物。
- `npm run typecheck` —— 对着 `@getpaseo/plugin`（devDependency，运行时由宿主提供）做类型检查。
- `npm run smoke` —— 编译插件并通过它驱动一次真实 ACP 会话（status 探测、桥握手、用量 discover+fetch）。
- `main` 是 `paseo plugin add` 跟踪的分支；发布以 git tag 标记（形如 `v0.3.2`）。

## 许可证

本插件采用 [MIT](LICENSE)。它安装的桥（`zcode-acp-server`）随 npm 分发，遵循其自身的 Apache-2.0 许可证。图标取自 Z.ai 官方 logo，仅用于指示本插件包装的是哪个 agent。
