# dsh-desktop

DeepSeek Harness 的一键桌面启动器（MVP 原型）：双击即启动一个**独立的原生窗口**运行 DeepSeek Harness 的 Web 界面，关窗即退出。

## 环境要求

- Node.js（建议 v20+，本项目在 v24 上验证）
- 首次运行需要联网下载依赖

## 快速开始

**方式一：双击 `start.bat`**（推荐）
首次会自动执行 `npm install` 装依赖，之后每次双击直接启动。

**方式二：命令行**
```bash
npm install   # 仅首次
npm start     # 编译 TS 并启动
```

## 工作原理

```
start.bat
   └─ npm start
        └─ electron .          （主进程）
             ├─ spawn dsh web --port 0   ← 启动真正的 Harness（子进程）
             ├─ 解析 stdout: "dsh web: http://127.0.0.1:PORT"
             └─ 打开 BrowserWindow 加载该地址
```

- **端口自动分配**：传 `--port 0` 让系统挑空闲端口，再从 stdout 抓取真实地址，不会撞端口。
- **单实例**：重复双击只会聚焦已开窗口，不会开第二个。
- **生命周期**：关闭窗口 → 优雅停止 dsh 子进程；dsh 意外退出 → 自动关窗。
- **工作目录**：默认用 `~/dsh-workspace` 作为 Harness 的工作区，可在 `config.json` 里修改（见下）；Harness 自身数据目录（`home`）也可指到 E 盘。

## 配置

`config.json`（放在项目根目录，可缺省，缺省时回退默认值）：

```json
{
  "workspace": "E:\\Deepseek Harness\\workspace",
  "home": "E:\\Deepseek Harness\\.dsh"
}
```

- **`workspace`**：Harness 的工作区根目录（智能体读写文件的目录）。优先级：`config.json` → 环境变量 `DSH_WORKSPACE` → 默认 `~/dsh-workspace`。
- **`home`**：Harness 自身数据目录（配置、密钥、会话历史、profile）。优先级：`config.json` → 环境变量 `DSH_HOME` → 默认 `~/.dsh`。把它指到 E 盘即可让 DSH 数据完全不占 C 盘。

> 留空字符串或删除字段 = 使用默认值；路径里的反斜杠要写成 `\\`（JSON 转义）。

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_WORKSPACE` | 工作区根目录（`config.json` 优先） | `~/dsh-workspace` |
| `DSH_HOME` | Harness 数据目录（`config.json` 优先） | `~/.dsh` |
| `DSH_DESKTOP_NODE` | 用来跑 dsh 的 node 可执行文件 | `node`（PATH 上的） |

## 项目结构

```
dsh-desktop/
├── src/electron/main.ts   # 窗口 + 生命周期
├── src/electron/dsh.ts    # spawn dsh + 解析端口
├── config.json            # 工作区、数据目录等配置（可选）
├── package.json
├── tsconfig.json
├── start.bat
└── README.md
```

## 常见问题

- **Electron 二进制怎么来的**：Electron 43 起不再通过 `npm install` 的 postinstall 下载，而是在首次运行 `electron` 时按需下载（`node_modules/electron/index.js` 检测到缺失会自动调 `install.js`）。GitHub 顺畅时无需任何操作；若想手动下载或走国内镜像：
  ```bat
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  node node_modules\electron\install.js
  ```
- **npm 提示 `allow-scripts` 拦截了某些包的安装脚本**：npm 11 对未白名单的脚本只警告不执行。经实测（`dsh web` 冒烟测试通过）这不影响 Web 界面启动，因为这些原生模块（koffi 等）在 Web 表层是懒加载/未使用的。

## 下一步（正式打包成安装包）

MVP 跑通后，可以用 electron-builder 打包成 `.exe`：

1. 内嵌一个与依赖匹配的便携 `node.exe`（放进 `resources/runtime/`），实现"用户零依赖"；
2. 配置应用图标、系统托盘常驻；
3. `electron-builder --win` 产出安装程序。

> 说明：内嵌的 Node 与本机已装的 Node 完全隔离，互不影响。
