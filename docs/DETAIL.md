# 截图桥

在任意程序里按一个快捷键，整屏截图会直接落到指定对话里，省掉「切窗口、粘贴、再描述」这一串动作。

## 它做了什么

- **系统级快捷键**：独立的 PowerShell 助手调用 Win32 `RegisterHotKey`（键盘）或 `WH_MOUSE_LL` 低级鼠标钩子（侧键/滚轮），所以 DSH 不在前台也能触发。默认 `Alt+Z`；可配置 `Alt+XButton1`、`Ctrl+WheelUp` 等。
- **截屏**：按下时立即用 GDI 抓屏，存成 PNG；默认抓鼠标所在的那块屏幕，可选整块虚拟桌面。键盘助手在第一次 `WM_HOTKEY` 后自行解除武装，轮询 `GetAsyncKeyState` 等触发键松开后再接受下一次按下；侧键在松开消息后重新武装；滚轮触发后 600ms 冷却。所以长按、连续滚轮都不会连发。
- **投递**：Host 半把新截图交给浏览器半，后者把图上传成一条带图的用户消息，发进目标对话。
- **设置卡片**：设置 → 截图桥，用 `Config` schema 的 volatile 字段提供默认值，卡片编辑开关、快捷键、会话 ID，以及「截取全部屏幕」「附带文字」。保存写入 `%DSH_HOME%\screenshot-bridge\settings.json`，不依赖 profile 直属行；改键/开关即时重启助手。

## 设置卡片

卡片里有：

| 项 | 作用 |
|---|---|
| 启用截图桥 | 关闭即注销全局热键、停止投递 |
| 快捷键 | 点「录制」按键盘组合、鼠标侧键或滚轮，或直接输入；保存/失焦后即时生效 |
| 会话 ID | 固定投递目标；必须填写。格式 `session-<uuid>` |
| 截取全部屏幕 | 多屏时截整个虚拟桌面 |
| 附带文字 | 随图发送；默认就是你填的题库提示语，`{time}` 替换为本地时间。6 行多行输入框，整行宽，可拉伸；本地编辑后点「保存」，离开设置页也会自动提交 |

## 界面

只在「设置 → 截图桥」出现；对话框、输入框周围不挂任何插件控件。

## 实现要点

- Host 半导出 `Config`（schemastery，字段均 `.volatile()`）作为首次启动/profile 默认值；卡片通过 `POST /api/screenshot-bridge?op=save` 把校验后的字段写入 `settings.json`，Host 立即重排助手，`loader/volatile-update` 与 1.5s 轮询在尚无 `settings.json` 时兜底。
- `settings.json` 是卡片保存后的唯一准据；`dsh.profile.bundles` 只负责加载。这样内置插件管理器只加 bundle 行、不建 profile 直属行时，设置仍然可写。可在 profile 的 `cordis.patch.yml` 里放直属 `config` 行作为首次保存前的可选默认值，但保存卡片后不再覆盖。
- 保存链路：客户端 `writeField` → Host 校验/合并 → 追加串行写临时文件并原子替换；失败重试一次；输入失焦、离开设置页（组件卸载）都会把仍为 dirty 的草稿提交。
- 投递路径：`createDrafts` → 等上传 → `sessions.using(sessionId)` → `sendSession(..., 'queue')`；失败回滚草稿。

## 没有做的

- 不做区域框选，只做全屏。
- 不监听剪贴板，不替换系统截图工具。
- 关闭 DSH 期间产生的截图不会在重开时补发。
