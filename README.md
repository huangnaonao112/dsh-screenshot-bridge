# 截图桥

按一次系统级快捷键，截下当前屏幕，并把图作为一条消息发到指定的 DeepSeek Harness 对话。

设置全部在 **设置 → 截图桥** 这张卡片里：插件开关、快捷键、会话 ID（另附「截取全部屏幕」与「附带文字」两个附加项）。默认值来自包的 `cordis.patch.yml`；卡片保存写入 `%DSH_HOME%\screenshot-bridge\settings.json`，不依赖 profile 里是否存在直属配置行，所以内置安装器安装后也能直接改。

## 安装

包名是 **`dsh-screenshot-bridge`**，当前发布版本 **`1.15.1`**。它是独立 DSH 插件，只依赖 DSH 运行时和 Windows PowerShell，不依赖其他本地插件。

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

**方式零（npm 2FA 未批时的等价安装）**：直接从 GitHub 装，内容与 npm 包完全一致。

```powershell
cd ~/.dsh/profiles/<profile>
npm install github:huangnaonao112/dsh-screenshot-bridge#v1.15.0
# 或
npm install https://github.com/huangnaonao112/dsh-screenshot-bridge/releases/download/v1.15.0/dsh-screenshot-bridge-1.15.0.tgz
```

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
- 图片存于插件目录下的 `.shots/`（沙箱只允许写工作区；可用 `DSH_SHOT_DIR` 覆盖），保留最近 40 张；内存里的截图条目与磁盘文件同步淘汰，不会再出现指向已删文件的 404。
- 目标对话忙碌时消息排队，不打断正在跑的回合；失败原因写入 `bridge.log`。
- DSH 关闭期间按快捷键，截图仍会生成；重开应用后不会把积压的图补发进对话。
- 关闭开关后助手退出，不再投递；对话框下面不会出现任何插件控件，全部配置只在设置卡片里。

## 局域网看答案（1.9.0）

同一个局域网里的手机/平板，用浏览器打开卡片上给的地址，就能看到：最新截图、本地识别出的文字、模型的回答；页面上还有一个「拍一张」按钮，不用碰电脑。

- 服务在 Host 进程里，监听 `0.0.0.0:<lanPort>`（默认 8787；端口被占会自动往后试 8788–8796）。
- 地址自带访问口令：`http://<本机局域网IP>:8787/?k=<token>`，token 首次使用自动生成，写在 `settings.json` 的 `lanToken`。
- **卡片里直接出二维码**：设置 → 截图桥 →「局域网看答案」一栏上方就是这张地址的 QR（Host 用内置 `qr.mjs` + 厂商版 qrcode-generator 生成 SVG），手机扫一下即可，不用手输。二维码随地址/端口/token 变化自动刷新。
- 回答从 DSH 的目标会话里读：截图发出后盯住该会话，出现新的 assistant 消息就挂到这张截图上（最多等 180 秒）。会话没打开时页面显示「会话未打开」。
- 页面每 1.2 秒刷新一次；历史保留最近 20 张。
- **安全**：这是明文 HTTP + query token，同一局域网里拿到 URL 的人都能看。不要在不可信网络里开；关掉卡片上的「局域网看答案」服务即停。

卡片「局域网看答案」一栏：二维码给手机扫，下面那行地址仍可直接选中复制（扫码失败时手输）。
- 设置卡片：会话 ID 整行显示（11px 等宽）+ 「复制」按钮；截全屏/绕保护/采集通道/截哪一块/存图格式 收进「高级设置 ▾」，默认只留常用项，卡片高度约减一半。

## 采集通道与截图保护（1.8.0）

截图不再是「按一次拉一个 PowerShell 再拉一个截图 exe」。现在是**一个常驻进程**（`bin/dshshotd.exe`）：

- **热键 + 采集 + 清保护同进程**：注册全局热键、DXGI 采集、清 `SetWindowDisplayAffinity` 都在一个进程里，
  不再每次 spawn。按下到 PNG 落盘实测 **45–70 ms**（旧链路 489 ms）。
- **预录**：常驻缓存最近 0.6 秒的帧（8 张 GPU 纹理，约 120 MB 显存），按快捷键取**按下前**那一帧——
  客户端一失焦就糊屏的场面靠这个救回来。设置卡片「预录刚才那一刻」默认开。
- **清保护不留 DLL**：不再往目标进程塞 `wdapay.dll`，改成在目标进程里跑一段一次性 stub 线程调用
  `SetWindowDisplayAffinity(hwnd, WDA_NONE)`；目标进程的模块列表里看不到任何新增文件。
  受保护窗口先清后截（`cleared:1`），未受保护窗口则用预录帧。
- **内核档（可选）**：用户态开不了句柄的目标，装 `capture/kdrv/dshshot.sys` 由内核在目标进程建线程；
  没有签名证书时需 `bcdedit /set testsigning on` 并重启一次（已注册好，见 `capture/kdrv/install.ps1`）。
- **窗口级抓取**：清掉保护后 `PrintWindow(PW_RENDERFULLCONTENT)` 能渲染窗口自己，所以受保护窗口只截那一块——不怕被遮挡、图从 2560×1440 缩到窗口尺寸（实测 520×340、8.8 KB）。卡片「截哪一块」可选自动/窗口/整屏。\n- **表格重排**：框线太淡或没有框线的数据表（资料分析那种）会按 OCR 坐标重排成 `a | b | c`，表头也带上；一页多张表分别重排、分别裁图；同时把表格区域裁图附给模型。\n- **JPEG 快速编码**：同一画面 PNG 编码 118 ms、JPEG(q95) 18 ms（6 倍）。卡片「存图格式」可切，默认 PNG 无损。\n- **兜底**：`bin/shotcap.exe`（CLI）和 `hotkey.ps1`（PowerShell）都还在，删掉 daemon 也能跑，只是回到 0.5–1 s。

实测（本机 Win11 26200）：`capture/test-daemon.ps1` → 5 次全部走 ring，avg 46 ms；
`capture/test-wda.ps1` → 清前 108.9 / 清后 135.8，窗口内容真的出现了。

边界：DRM / OPM 保护的内容（Netflix、PlayReady、HDCP 链路）在任何软件层都是黑屏，只有硬件采集卡能解；
保护进程能否被打开取决于对方是否 PPL；32 位目标进程不支持注入。

## 题面提取（可选，设置卡片里二选一）

截图里常常既有题目又有水印、侧栏、倒计时、摄像头小窗、按钮。两个方案同时保留，卡片上「截图怎么给模型」一键切换：

- **直接发截图**：和以前一样，把 PNG 原图发给模型。
- **原截图 + 文字**：**原图一定发**，本地再附一份从图里认出来的文字。文字只当辅助（可复制、可搜索、少读错字），**内容以截图为准**；一个字都没认出来就只发截图。这一步完全离线、不用任何大模型，也不改写原文。

> 为什么要改成"原图必发"：实测 18 张真实网页截图（力扣、洛谷、Codeforces、无忧考网、PDF 真题页），结构切题只对"题号 + A/B/C/D"这一族题库版式成立，编程题站和文档预览页切出来只剩几个字。原图始终在，覆盖率就永远是 100%。

- 引擎是 `extract.mjs`（RapidOCR 的 Node 实现 + 版面规则）。**用户不需要装 Python，也不需要装任何东西**：`npm install` 会把 `rapidocr-node`、`onnxruntime-node`、`sharp` 一起装好，PP-OCRv6 模型（约 30 MB）随仓库自带在 `models/`。
- 依赖体积：`onnxruntime-node` 装完约 287 MB（含 macOS / Linux / win32 各平台二进制；实际用到的是 `bin\napi-v6\win32` 那一份）。纯 npm 分发，没有 exe，也没有杀软提示。
- 运行方式：Host 用**自己这个 Node 运行时**（DSH 的 `node.exe`，v24）起一个子进程跑 `extract.mjs`，所以不会卡住界面；同一次截图只跑一次，结果在内存里缓存。
- 开发机兜底：`extract.py` 仍然保留，Node 引擎起不来时会退到本机 Python（要关掉就设 `DSH_EXTRACT_PYTHON=0`）。
- 两种模式：`mode=list/single` 是"题号 + 选项"版式，输出切好的题；`mode=raw` 是这页没有题库结构（力扣/洛谷/文档预览），自动改成按阅读顺序输出整页文字。判定：整页文字量 ≥120 字、而切题结果不到它的 60% 时，自动走 `raw`。
- Host 路由：
  - `GET ?op=extract&id=<capture>` → `{ok, engine, mode, text, questions, figures, gaps, stats}`；同一张图只算一次（内存缓存）。
  - `GET ?op=figure&id=<capture>&n=<序号>` → 该次提取裁出的第 n 张题图（PNG 字节，只允许读 `figs/` 下面）。**这张裁图默认不再单独发送**（原图里已经有），接口留着给别的用途/调试。
- 发送顺序：取原截图 + 取文字 → 一次发出「原截图 + 附带文字 + 识别文字」；任何一步失败（超时、引擎起不来、对话拒收）就**自动回退成只发原截图**，不会让截图发不出去。
- 单张耗时约 2–3 秒（含加载模型，子进程每次都要加载一次）；嫌慢就切回「直接发截图」。
- 已认过的版式：题库网站的纵向长图（多益在线笔试、aypta、无后束）、**Chrome 内置 PDF 阅读器的真题页**（深灰外框 + 白纸页 + PDF 工具栏 + `第15页/共24页` 页脚）、深色主题反色页、左侧带答题卡栏、右侧带客服/二维码浮窗。PDF 页的工具栏、权限提示条、"本试卷由 xx 提供"页脚当杂项剔掉；同一行并排写的 `A.…B.…C.…D.…` 会按选项标记切开，各占一行。
- 截图 PNG 有时带 alpha 通道（4 通道）。取色前会先剥成 3 通道，否则白纸页会被错判成"一片高饱和色块"，整行正文被当成按钮丢掉。
- 列选择按"这一列的文字总量"量，不按汉字占比（英文页面汉字占比是 0）；单个像题号的行（洛谷右上角的 `P1001`）不再能抢走整列。
- 题图裁切：**先把 OCR 已经认出来的字整块涂掉**，剩下的墨迹才是"图"——这样整段文字不会和旁边的图粘成一块。然后按墨迹找连通块、把上下相邻和**并排的**块都粘起来 → 甩掉横条/过小/过稀的 → 按上方最近题号归档，外扩约一个字高存 PNG（碰到上下相邻文字行之前收住，不会把题干残字带进画里）。
- 认漏了怎么办：题号整个没认出来（只剩"根据上述定义…"这种长句）按顺序补成 `4、（补号）…`；选项字母被吞（只剩 `②⑤⑥` 这种内容）按字母顺序补成 `B、（补号）②⑤⑥`。带（补号）的都是推断出来的，不是图上原样看到的。
- 模型许可：PP-OCRv6 检测/识别模型与字典来自 RapidOCR，见 [`docs/MODELS-LICENSES.md`](docs/MODELS-LICENSES.md)。

## 配置字段

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件开关；关掉即注销全局热键并停止投递 |
| `hotkey` | `Alt+Z` | 全局快捷键；也可填鼠标侧键/滚轮，如 `Alt+XButton1`、`Ctrl+WheelUp` |
| `sessionId` | 空 | 固定投递的会话 id；留空不会投递 |
| `allScreens` | `false` | 截整块虚拟桌面而非鼠标所在屏幕 |
| `prompt` | `我给的截图里面有一些题，你根据截图里的题目按顺序给出答案。只给干净的答案，不要给思考过程` | 随截图发送的文字，`{time}` 替换为本地时间；清空则只发图 |
| `mode` | `extract` | `image` = 直接发截图；`extract` = 本地提取题面文本 + 题图后发送 |
| `captureBackend` | `auto` | `auto` = 桌面复制优先、黑屏退 GDI；`gdi` = 传统 BitBlt；`dxgi` = 强制桌面复制 |
| `clearProtection` | `true` | 截图前清掉前台窗口的 `SetWindowDisplayAffinity` 保护（stub 线程，必要时再走内核 `dshshot`） |
| `prebuffer` | `true` | 常驻缓存最近 0.6 秒，按下时取触发前的帧 |
| `selfCheck` | `true` | 答完让模型回读截图核对，对不上的题标「待核」 |
| `ocrModel` | `small` | `small` / `medium`（`medium` 更准更慢，需先 `npm run models:medium`） |
| `captureTarget` | `auto` | `auto` 受保护时只截前台窗口；`window` 只截窗口；`screen` 整屏 |
| `imageFormat` | `png` | `png` 无损慢；`jpg` 快 6 倍（q95） |
| `lanEnabled` | `true` | 是否在局域网提供看答案页面 |
| `lanPort` | `8787` | 页面端口；被占会自动往后试 |
| `lanToken` | 自动生成 | 页面访问口令 |
| `extract` | `true` | 旧布尔别名，等价于 `mode` 的两种取值，仅为兼容旧设置文件 |

诊断日志：`%DSH_HOME%\screenshot-bridge\bridge.log`。卡片设置：`%DSH_HOME%\screenshot-bridge\settings.json`。Host 路由：`/api/screenshot-bridge`，`op ∈ {state, wait, image, extract, figure, diag, save}`。

## 自测（改代码之前先跑）

```bash
npm test           # node test-suite.mjs：一次跑完下面所有检查，全过才退出 0
npm run matrix     # 只跑 32 个合成变体
```

`npm test` 一共 54 条断言：

1. **32 个合成变体**：拿四张真实截图当底片（题库长图六图页、体块题页、纯文字题页、**Chrome PDF 真题页**），程序化生成 0.75 / 0.9 / 1.15 / 1.4 倍缩放（模拟分辨率与字号）、左侧加答题卡栏、右侧加二维码浮窗、整图反色（深色主题）。图形页的 `figs` 必须和底片一致（六图页 2、体块题 1、PDF 页 2），纯文字页必须 0；字数不允许整行/整题消失。
2. **8 张真实网页截图**：力扣 ×3、洛谷 ×2、Codeforces、无忧考网文档预览，各自有最低字数门槛（如力扣两数之和 ≥250 字、洛谷 ≥380 字、Codeforces ≥800 字）。
3. **4 张真机截图**：PDF 页、体块题、六图页、纯文字页的字数与图数。
4. **校验告警**：把一页故意裁掉下半，必须主动报「第 82 题只认到题号，题干和选项都没认出来」。
5. **双栏切分**：左栏必须整段先输出，右栏单独标注，不能串行。
6. **表格重排**：程序化画一张 3 列 × 4 行带框线的表格，提取结果里必须出现`【表格重排】3 列`且每行按`a | b | c`排好；纯文字页不能误报表格。

底片存在 `testdata/`（4 张，约 1.3 MB），不依赖任何外部路径，clone 下来就能跑。

## 体积与安装

- `npm install` 会跑 `scripts/postinstall.mjs`：
  - `scripts/fetch-models.mjs --optional`：`models/` 里三件套缺了或 sha256 不对，就从 ModelScope 的 `v3.10.0` 重下（det 9.5 MB / rec 20 MB / 字典 74 KB），失败只警告；
  - `scripts/prune-onnxruntime.mjs`：删掉 `onnxruntime-node` 里 macOS / Linux / Windows-arm64 的二进制和 DirectML/dxcompiler，**287 MB → 27.7 MB**，CPU 推理照常。
- 可选高精度模型：`npm run models:medium` 会下 det 62 MB + rec 76 MB 到 `models/medium/`，然后设 `DSH_EXTRACT_MODEL=medium` 启用。实测它在 PDF 页会把两排图并成一张、且慢 2–3 倍（5–7 秒/张），**所以默认不用**，只有你在意小字时才开。

## 限制

- 仅 Windows：依赖 Win32 全局热键、低级鼠标钩子与屏幕捕获。
- 截图保护清除只对 `SetWindowDisplayAffinity` 生效；DRM / OPM（PlayReady、HDCP 链路）在驱动层就换掉了像素，软件层无解；PPL/保护进程可能拒绝打开（原因写进 `bridge.log`）；32 位目标进程不支持注入。
- 键盘快捷键若被别的程序占用，卡片状态会显示错误，换一个组合即可；鼠标侧键/滚轮用的是全局低级钩子，若被安全软件拦下会显示未注册。
- 横向滚轮（`WheelLeft` / `WheelRight`）取决于鼠标驱动是否发送 `WM_MOUSEHWHEEL`，普通鼠标通常只有上下滚轮。
- 同一时间只应有一个 DSH 窗口在接收；多开窗口会各自拉取同一批截图。
- 会话 ID 只校验格式（`session-<uuid>` 或裸 uuid）；不存在的 id 会在发送时失败并显示原因。
- 题面提取的引擎是本插件的 npm 依赖（`rapidocr-node` + `onnxruntime-node` + `sharp`）+ 自带的 `models/`，装完即用；起不来时不会报错，只是退回发图。固有短板：填空下划线 `____` 会丢；OCR 认错题号时图可能挂错题；套在深色主题里的浅色文字可能被墨迹阈值漏掉；题目在表格里、或图与文字完全重叠时可能切错；一行被压得很长的续行会单独成行而不并回上一句。这些都写进 `bridge.log` 的 `extract` 行，`ok:false` 时一定会退回发图。
- **表格**：页面上有框线（横线 ≥3 条、竖线 ≥2 条）时，会把 OCR 的行按单元格重新排成 `a | b | c`，附在正文后面，标题为`【表格重排】N 列`。没有框线、只靠空格的表格仍然只能靠"整页文字 + 原图必发"兜着——这条要用版面检测模型才能解，而 PaddleOCR 的 PP-DocLayout 官方只发 paddle 权重，唯一现成的 ONNX 单个就 204 MB，和「纯 npm、别人装走即用」冲突，所以先用框线规则解掉最常见的一类（真题里的统计表都带框线）。

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

当前 npm 版本是 `1.15.1`。后续发布：

```powershell
npm version patch
npm publish --access public
```

npm 已不再提供 Classic / Automation token；直接发布需要账号开启 2FA，或使用带 **Bypass 2FA** 的 Granular Access Token。`package.json` 的 `author` / `repository` / `homepage` 已指向 `huangnaonao112/dsh-screenshot-bridge`；仓库改名时同步更新。GitHub 仓库用于查看源码和提交 issue，安装优先用上面的 npm 包名。









