# 截图桥

按一次系统级快捷键，截下当前屏幕，并把图作为一条消息发到指定的 DeepSeek Harness 对话。

设置全部在 **设置 → 截图桥** 这张卡片里：插件开关、快捷键、会话 ID（另附「截取全部屏幕」与「附带文字」两个附加项）。默认值来自包的 `cordis.patch.yml`；卡片保存写入 `%DSH_HOME%\screenshot-bridge\settings.json`，不依赖 profile 里是否存在直属配置行，所以内置安装器安装后也能直接改。

## 安装

包名是 **`dsh-screenshot-bridge`**，当前发布版本 **`1.0.1`**。它是独立 DSH 插件，只依赖 DSH 运行时和 Windows PowerShell，不依赖其他本地插件。

**方式一：DSH 内置安装器，输入包名（推荐）**

侧栏 **插件 → 添加插件 → 安装第三方插件**，输入：

```text
dsh-screenshot-bridge
```

要固定版本可以输入：

```text
dsh-screenshot-bridge@1.0.1
```

**方式二：DSH 内置安装器，输入 GitHub 地址**

在同一对话框输入：

```text
https://github.com/huangnaonao112/dsh-screenshot-bridge
```

如果安装器提示需要 SSH 凭据，改用方式一的包名；本机 npm 对 `github:` 简写默认会走 SSH，没配公钥会失败。

**方式三：命令行安装**

```powershell
cd ~/.dsh/profiles/<profile>
npm install dsh-screenshot-bridge@1.0.1
```

也可以 clone 后本地 link：

```powershell
git clone https://github.com/huangnaonao112/dsh-screenshot-bridge.git C:\src\dsh-screenshot-bridge
cd ~/.dsh/profiles/<profile>
npm install link:C:/src/dsh-screenshot-bridge
```

然后 profile 的 `package.json` 把包加入 `dsh.profile.bundles` 负责**加载**：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": {
  "dsh-screenshot-bridge": "^1.0.1"
},
"dsh": {
  "profile": {
    "bundles": [
      "dsh-screenshot-bridge"
    ]
  }
}
```

使用 DSH 插件页安装并点「立即启用」时，这一步会自动完成。`cordis.patch.yml` 里的配置行只是**可选的 profile 默认值**；设置卡片的保存不依赖它。只有 bundle 行时插件照常加载，设置也能保存。

如果确实想在 profile 里预置默认值，可以再加一条直属行；它只覆盖首次保存前的默认值：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml（可选）
- id: screenshot-bridge
  name: "dsh-screenshot-bridge"
  config:
    enabled: true
    hotkey: Alt+Z
    sessionId: session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    prompt: 我给的截图里面有一些题，你根据截图里的题目按顺序给出答案。只给干净的答案，不要给思考过程
```

配置卡片第一次保存后，`settings.json` 成为准；之后改 profile 默认值不会覆盖已保存的设置。删除 `%DSH_HOME%\screenshot-bridge\settings.json` 可回到默认值。

如果本目录下无法解析 `@deepseek-ai/schemastery`，把它指向 profile 里的同一份：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target ~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/schemastery
```

## 用法

1. 设置 → 截图桥：打开「启用截图桥」，设定快捷键（点「录制」后按键盘组合、鼠标侧键或滚轮，也可直接输入），填写固定投递的会话 ID（`session-<uuid>`，必须填写；留空不会投递）。
2. 在任何程序里按快捷键：截图落盘后由插件上传并作为一条消息发进目标对话，模型直接看到这张图。

快捷键支持键盘和鼠标：键盘至少一个修饰键（如 `Alt+Z`、`Ctrl+Alt+Shift+F10`，支持三键及以上组合）；鼠标侧键 `XButton1` / `XButton2`（即鼠标 4/5 键，也可写 `Mouse4` / `Mouse5`）、中键 `MiddleButton`，滚轮 `WheelUp` / `WheelDown` / `WheelLeft` / `WheelRight`，都可单独使用或带修饰键，如 `Alt+XButton1`、`Ctrl+WheelUp`。

## 行为细节

- 附带文字用多行输入框（默认 6 行、整行宽度、可上下拉伸，足够容纳 100 字以内），先在本地编辑，点旁边的「保存」才写入 Host；离开设置页时若还没保存也会自动落盘到 `settings.json`，不会丢改动。不会每敲一个字就写一次文件，避免输入被配置刷新打断。
- 快捷键改动点「保存」或失焦即写 `settings.json` 并**立即重启助手**，不需要重启 DSH；从设置页返回时，仍为保存的草稿也会自动提交。
- 键盘组合由独立的 PowerShell 助手用 Win32 `RegisterHotKey` 注册，鼠标侧键/滚轮由低级鼠标钩子 `WH_MOUSE_LL` 注册，**窗口不在前台也能用**。一次按下（含长按侧键）只截一张，松开后才接受下一次；滚轮一格触发一次，600ms 冷却防止惯性连发。
- 默认截「鼠标所在的那块屏幕」；打开「截取全部屏幕」时截整个虚拟桌面（多屏拼成一张）。
- 图片存于 `%DSH_HOME%\screenshot-bridge\shots`（默认 `~/.dsh/...`），保留最近 40 张。
- 目标对话忙碌时消息排队，不打断正在跑的回合；失败原因写入 `bridge.log`。
- DSH 关闭期间按快捷键，截图仍会生成；重开应用后不会把积压的图补发进对话。
- 关闭开关后助手退出，不再投递；对话框下面不会出现任何插件控件，全部配置只在设置卡片里。

## 配置字段

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件开关；关掉即注销全局热键并停止投递 |
| `hotkey` | `Alt+Z` | 全局快捷键；也可填鼠标侧键/滚轮，如 `Alt+XButton1`、`Ctrl+WheelUp` |
| `sessionId` | 空 | 固定投递的会话 id；留空不会投递 |
| `allScreens` | `false` | 截整块虚拟桌面而非鼠标所在屏幕 |
| `prompt` | `我给的截图里面有一些题，你根据截图里的题目按顺序给出答案。只给干净的答案，不要给思考过程` | 随图发送的文字，`{time}` 替换为本地时间；清空则只发图 |

诊断日志：`%DSH_HOME%\screenshot-bridge\bridge.log`。卡片设置：`%DSH_HOME%\screenshot-bridge\settings.json`。Host 路由：`/api/screenshot-bridge`，`op ∈ {state, wait, image, diag, save}`。

## 限制

- 仅 Windows：依赖 Win32 全局热键、低级鼠标钩子与屏幕捕获。
- 键盘快捷键若被别的程序占用，卡片状态会显示错误，换一个组合即可；鼠标侧键/滚轮用的是全局低级钩子，若被安全软件拦下会显示未注册。
- 横向滚轮（`WheelLeft` / `WheelRight`）取决于鼠标驱动是否发送 `WM_MOUSEHWHEEL`，普通鼠标通常只有上下滚轮。
- 同一时间只应有一个 DSH 窗口在接收；多开窗口会各自拉取同一批截图。
- 会话 ID 只校验格式（`session-<uuid>` 或裸 uuid）；不存在的 id 会在发送时失败并显示原因。

## 发布到 GitHub

仓库根目录已经是一个独立 npm 包（`package.json` 的 `name` 为 `dsh-screenshot-bridge`）。发布时不要把 `node_modules/`、`debug.log`、`shots/` 提交进去，`.gitignore` 已经处理。

```powershell
git init -b main
git add .
git commit -m "feat: DeepSeek Harness screenshot bridge"
git remote add origin https://github.com/huangnaonao112/dsh-screenshot-bridge.git
git push -u origin main
```

也可以在 GitHub 网页新建空仓库后执行最后两行；如果装了 GitHub CLI，可用 `gh repo create dsh-screenshot-bridge --public --source=. --push`。

当前 npm 版本是 `1.0.1`。后续发布：

```powershell
npm version patch
npm publish --access public
```

npm 已不再提供 Classic / Automation token；直接发布需要账号开启 2FA，或使用带 **Bypass 2FA** 的 Granular Access Token。`package.json` 的 `author` / `repository` / `homepage` 已指向 `huangnaonao112/dsh-screenshot-bridge`；仓库改名时同步更新。GitHub 仓库用于查看源码和提交 issue，安装优先用上面的 npm 包名。
