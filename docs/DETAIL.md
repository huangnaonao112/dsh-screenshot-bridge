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
| 绕过截图保护 | 截图前清前台窗口的 `SetWindowDisplayAffinity`；有内核驱动时再多一层 |
| 采集通道 | 自动 / 桌面复制（DXGI）/ GDI |\n| 预录刚才那一刻 | 常驻缓存 0.6 秒，按下取触发前的帧 |
| 截哪一块 | 自动 / 只截窗口 / 整屏 |
| 存图格式 | PNG（无损）/ JPEG（快 6 倍） |
| 高级设置 | 折叠区：截全屏、绕保护、采集通道、截哪一块、存图格式 |\n| 答完自检 | 附一句「答完对照截图核对，对不上的标待核」 |
| 附带文字 | 随图发送；默认就是你填的题库提示语，`{time}` 替换为本地时间。6 行多行输入框，整行宽，可拉伸；本地编辑后点「保存」，离开设置页也会自动提交 |

## 界面

只在「设置 → 截图桥」出现；对话框、输入框周围不挂任何插件控件。

## 实现要点

- Host 半导出 `Config`（schemastery，字段均 `.volatile()`）作为首次启动/profile 默认值；卡片通过 `POST /api/screenshot-bridge?op=save` 把校验后的字段写入 `settings.json`，Host 立即重排助手，`loader/volatile-update` 与 1.5s 轮询在尚无 `settings.json` 时兜底。
- `settings.json` 是卡片保存后的唯一准据；`dsh.profile.bundles` 只负责加载。这样内置插件管理器只加 bundle 行、不建 profile 直属行时，设置仍然可写。可在 profile 的 `cordis.patch.yml` 里放直属 `config` 行作为首次保存前的可选默认值，但保存卡片后不再覆盖。
- 保存链路：客户端 `writeField` → Host 校验/合并 → 追加串行写临时文件并原子替换；失败重试一次；输入失焦、离开设置页（组件卸载）都会把仍为 dirty 的草稿提交。
- 投递路径：`createDrafts` → 等上传 → `sessions.using(sessionId)` → `sendSession(..., 'queue')`；失败回滚草稿。

## 题面提取（可选，`mode` 二选一）

截图上除了题目还有水印、侧栏、倒计时、摄像头小窗、按钮。`mode` 有两个取值，卡片上「截图怎么给模型」直接切换，两个方案都保留：

- `image`：老行为，把 PNG 原图发给模型。
- `extract`：Host 先在本地把图**变成文字**（能认出题库结构就切题，认不出就整页全文），浏览器半把「**原截图 + 附带文字 + 识别文字**」一起发；模型看到的是原图和一份可复制的文字，两者不一致以原图为准。任何一步失败都回退成只发原图。

- 实现：`extract.mjs`（Node 版，RapidOCR 的 Node 移植 `rapidocr-node` 认字 + 自适应版面规则切题 + 墨迹/文字覆盖率抠图），由 Host 用**插件自己的 Node 运行时**起子进程调用，读 stdout 的一行 JSON；`extract.py` 是同规则的 Python 版，保留作开发兜底。所有阈值从当前这张图自己统计（行高、列宽、缩进、重复度），题号/选项写法由本图投票选出，不含任何「按某家网站调出来」的常数，也不使用大模型。检测边长由引擎按图自适应，宽图不会被压小丢行。
- 依赖与体积：`rapidocr-node` + `onnxruntime-node` + `sharp` 走 npm，模型（PP-OCRv6 small det/rec + 字典，约 30 MB）随仓库放在 `models/`，用户 `npm install` 后即可用，**不需要 Python、不需要下载 exe**。`scripts/postinstall.mjs` 会做两件事：模型缺了/校验不过就从 ModelScope `v3.10.0` 重下（sha256 校验）；把 `onnxruntime-node` 里 macOS/Linux/Win-arm64 的二进制与 DirectML/dxcompiler 删掉，**287 MB → 27.7 MB**。
- 自检：`extract.mjs` 会自己核对结果——题号跳号、某题选项不足 2 个、只认出题号却没认出题干，都会写进 `warnings`；浏览器半把它附在提示词里，配合"原图必发"，模型可以回头核对。
- 版本无关的兜底：整页文字 ≥120 字而结构切题不到它的 60% 时，自动改成 `mode=raw` 整页输出；`rawTextOf` 检测到"左右两条竖列、中间明显空白"时先出左栏再出右栏，避免两栏文字串成一句。
- 表格：**有框线**时 `tableOf()` 用框线切格；**框线太淡/无框线**时 `tableByGrid()` 按 OCR 坐标重排（连续 ≥3 行、每行 ≥3 个短单元格、含 ≥2 个数字），并把表头（最多两行）一起收进；两者都会把表格区域裁成一张图附给模型（数字最容易认错）；**一页多张表**会分别重排、分别裁图，输出用「表1 · 8 列」「表2 · 8 列」区分；合并表头按列中心判定覆盖范围，每列用「/」把两层表头并成一行。原 `tableOf()` 规则：在灰度图上找连续深色像素段——某一 y 上最长连续段 ≥ 50% 宽算横线、某一 x 上 ≥ 30% 高算竖线，各自按 ≤2px 间距聚成一条；横线 ≥3、竖线 ≥2 才认定是表格（页面外框只有 2 条横线，不会误报）。命中后用框线当行列边界，把 OCR 行的中心点丢进单元格，按行拼 `a | b | c`，追加在正文后面，标题`【表格重排】N 列`。没有框线、只靠空格的表格仍交给"整页文字 + 原图必发"。
- 回归：`npm test`（`test-suite.mjs`）54 条断言——32 个合成变体 + 8 张真实网页截图 + 4 张真机截图 + 校验告警 + 双栏切分 + 表格重排（含"纯文字页不得误报"），全过才退出 0；底片在 `testdata/`，不依赖外部路径。
- 运行隔离：OCR 在子进程里跑（`process.execPath` = DSH 的 node），不占宿主线程；每次调用都要加载一次模型，单张约 2–3 秒。
- 抠图判据一句话：**文字已经被 OCR 拿走了，剩下的墨迹必然是图**。灰度找墨迹 → 9×9 膨胀粘断线 → 滤掉横条/过小/过稀 → 被文字框覆盖 >30% 判为段落丢弃、<8% 且墨迹密度够就是图 → 相邻且横向重叠（含左右并排）的并块 → 按上方最近题号归档，外扩约一个字高裁 PNG（外扩会在碰到上下相邻文字行前收住，免得把题干残字带进画里），并在正文对应位置插入 `〔图N〕` 占位（左侧字母标签吸收进来）。
- 版式无关的做法：不认模板。深色主题按**居中区域**的灰度众数判定后先翻成浅底深字；PDF 阅读器的工具栏、权限提示条、`第X页/共Y页` 与"本试卷由 xx 提供"页脚按杂项剔除；同一行横排的 `A.…B.…C.…D.…` 遇到下一个选项标记就切断，各占一行。取色前统一剥掉 alpha 通道（截图 PNG 常是 4 通道，不剥会让白纸页被误判成一片高饱和色块，整行正文当按钮丢掉）。
- 路由：`GET ?op=extract&id=<capture>` → `{ok, mode, text, questions, figures, gaps, stats}`；`GET ?op=figure&id=<capture>&n=<序号>` → 第 n 张题图字节（只允许读 `figs/` 下，防目录穿越）。同一张图只算一次，结果缓存在内存里（最多 40 条）；`figs/<captureId>/` 按 mtime 只留最新 40 组。
- 降级约定：`ok:false` / 超时 / 没装引擎 / 对话拒绝消息 → 一律回退成「发图」，截图永远不会发不出去。日志里 `extract` 行记录 `ok`、`mode`、`reason`、字符数。
- 不变式测试：`npm run matrix` 用四张真机截图派生 32 个变体（缩放 / 加答题卡栏 / 加右浮窗 / 整图反色），图形页张数必须与底片一致、纯文字页必须是 0，改代码前先跑。
- 固有短板：填空下划线会丢（OCR 不认细线）、题号被认错时图会挂错题、深色主题下浅色文字可能被墨迹阈值漏掉、题目在表格里或图与文字完全重叠时可能切错、很长的续行会单独成行而不并回上一句。

## 采集通道与截图保护（1.6.0）

- **常驻 OCR（1.15.0）**：`ocr-server.mjs` 一次性加载模型，Host 通过 stdin/stdout 发请求；同图实测 1953ms（冷）→ 1518ms（热），比每张冷启动的 ~1970ms 省约 450ms。worker 崩溃/超时自动回退到一次性 `extract.mjs`。\n- **补图只补缺的**：`extract` 返回 `incomplete`（选项不全的题号），补图只挑这些题的裁图（最多 3 张）；LAN 页每张图多了「补发这张图」按钮，走 Host 队列 → 浏览器半补发。\n- **常驻进程（1.7.0）**：`bin/dshshotd.exe` 同时持有全局热键、帧环、采集和清保护，不再每次 spawn。实测按下→PNG 落盘 45–70 ms（旧 PowerShell 链路 489 ms）。帧环常驻缓存最近 0.6 秒（8 张 GPU 纹理，约 120 MB 显存），按快捷键时取**触发前**那一帧，专治"客户端一失焦就糊屏"。\n- **局域网页面（1.9.0）**：Host 内置 `lan.mjs`，在 `0.0.0.0:<lanPort>` 提供手机页面：最新截图 + 识别文字 + 模型回答 + 远程「拍一张」。口令 `lanToken` 走 query/header；设置卡片用 `op=qr` 取 `qr.mjs` 生成的 SVG 二维码（qrcode-generator 已 vendor），扫码直达；回答通过 `ctx.get("sessions")` 读目标会话的新 assistant 消息（180 秒窗口）。端口被占自动 +1 重试。\n- **窗口级抓取（1.8.0）**：清掉保护后 `PrintWindow` 能渲染窗口自身，所以受保护窗口只截那一块——不怕遮挡、图更小（实测整屏 2560×1440 → 窗口 520×340、8.8 KB）。卡片可选自动/窗口/整屏。\n- **JPEG 快速编码**：同一画面 PNG 118 ms、JPEG q95 18 ms；卡片可切，默认 PNG。\n- **三档采集**：`bin/shotcap.exe`。`dxgi` 走 `IDXGIOutput1::DuplicateOutput`（多屏按桌面坐标拼一张），
  `gdi` 走 `GetDC(NULL)` + `BitBlt(SRCCOPY|CAPTUREBLT)`，窗口模式还有 `PrintWindow(PW_RENDERFULLCONTENT)`。daemon 在受保护窗口上清完标志后改用实时 GDI 帧（缓冲帧是清之前的，仍是占位画面）。
  结果里带 `lit`（亮像素占比），全黑会被判成占位画面并自动换下一档，不会把黑图当截图发出去。
- **截图保护**：Windows 把「不许抓取」执行在 DWM 里，窗口调 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` 后
  任何走合成器的抓取都拿不到内容（本机 Win11 26200 实测：GDI 是黑块或露出背后画面，DXGI 同样，`PrintWindow` 直接黑）。
  因此本插件在截图前先查 `GetWindowDisplayAffinity(GetForegroundWindow())`，非 0 才清：
  1. 在目标进程里跑一次性 stub 线程（`CreateRemoteThread`，不加载任何 DLL），调用 `SetWindowDisplayAffinity(hwnd, WDA_NONE)`；目标进程模块列表零新增。`bin/wdaclear.exe` + `wdapay-<stamp>.dll` 仍保留给手工/批量场景；
  2. 还清不掉（保护进程/反作弊/用户态开不了句柄）时，若装了 `dshshot.sys`，用 `bin/dshcapctl.exe` 让内核打开进程并在其中建线程调用同一个 API。
- **内核档是可选件**：`capture/kdrv/dshshot.c`（WDM，`\Device\DshShotCap`，`IOCTL_DSHSHOT_CLEAR/_GUARD/_STATUS`）。
  不开源改 win32k、不依赖版本偏移——只做「在目标进程里执行一次 `SetWindowDisplayAffinity`」这一件事。
  没有签名证书时需 `bcdedit /set testsigning on` 并重启才会加载；`install.ps1` 会明说还需重启，不会假装已生效。
- **回归**：`pwsh -File capture/test-daemon.ps1` 连拍 5 张断言全走帧环、平均 < 150 ms；`pwsh -File capture/test-wda.ps1` 自造一个 `WDA_EXCLUDEFROMCAPTURE` 窗口，跑「保护 → 清标志 → 再抓」，
  断言两帧区域均值差 > 25；本机实测 `before 21.5 / after 135.8`。
- **边界**：DRM / OPM（PlayReady、HDCP 链路）在驱动层就把像素换掉了，清标志无效；PPL/保护进程可能拒绝打开；
  32 位目标进程不支持注入；旋转屏暂退 GDI。

## 没有做的

- 不做区域框选，只做全屏。
- 不监听剪贴板，不替换系统截图工具。
- 关闭 DSH 期间产生的截图不会在重开时补发。








