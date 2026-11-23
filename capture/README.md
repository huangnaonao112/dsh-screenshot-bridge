# 截图采集层（capture）

这一层把「截图桥」从"一条 PowerShell + GDI BitBlt"改成三档原生采集 + 一条绕过截图保护的链路。
核心结论先说：**能不能截到受保护的窗口，不取决于采集 API 有多底层，而取决于窗口对象上的
`SetWindowDisplayAffinity` 标志有没有被清掉。**

## 1. 原来为什么截不到

旧实现只有一条路：

```csharp
Graphics.CopyFromScreen(...)   // GetDC(NULL) + BitBlt(SRCCOPY)
```

Windows 把「这个窗口不许被抓取」这件事交给 DWM 合成器执行。窗口调用
`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` 之后，**任何**走合成器的抓取都会
拿到占位画面：

| 采集方式 | `WDA_MONITOR`(0x1) | `WDA_EXCLUDEFROMCAPTURE`(0x11) |
|---|---|---|
| GDI `BitBlt` | 黑块 | 窗口消失，露出背后画面 |
| `PrintWindow(PW_RENDERFULLCONTENT)` | 黑块 | 黑块 |
| DXGI `IDXGIOutputDuplication` | 黑块（Win11 26200 实测） | 窗口消失，露出背后画面 |

上表是在本机 Windows 11 build 26200 上跑 `shotcap.exe --selftest-wda` 的实测结果（`--wda`
分别取 `none / monitor / exclude`）。也就是说：**换更底层的用户态采集 API 并不能绕过**，
这也是为什么"调用内核"这件事必须落在"改窗口标志"上，而不是"换一个抓屏函数"。

## 2. 现在的分层

```
截图桥 Host (index.js)
  └─ dshshotd.exe（常驻：热键 + 预录 + 采集 + 清保护，一次启动管到底）
       ├─ FrameRing：DXGI 复制常开，最近 0.6 s 的帧留在 GPU 纹理里
       ├─ 按下热键
       │    ├─ 前台窗口 affinity ≠ 0 → 先清：
       │    │     stub 线程（CreateRemoteThread，无 DLL）→ SetWindowDisplayAffinity(hwnd, WDA_NONE)
       │    │     还是清不掉？ → dshcapctl.exe → dshshot.sys（内核建线程）
       │    ├─ 清过 → 取**清除之后**的实时帧（GDI），空白则退回环里的帧
       │    └─ 没清过 → 取**按下前**的环帧（prelag 250 ms）
       └─ 写 PNG，输出一行 JSON（backend / lag / ms / cleared）

  兜底链路（daemon 不在时）：
  hotkey.ps1 → wdaclear.exe / shotcap.exe / dshcapctl.exe
```

每一层都能独立工作：

- **stub 清保护**（daemon 内置）：在目标进程里跑一次性线程，不留 DLL；`wdaclear + wdapay` 仍保留作手工工具。绝大多数客户端（浏览器、在线考试客户端、网课客户端）都能清掉。
- **dshshot.sys**：内核。用于用户态开不了句柄的目标（保护进程、反作弊、别的用户/服务进程）。
- **shotcap / FrameRing**：采集。DXGI 优先，黑屏自动退 GDI，并对结果做"亮像素占比"检测，避免把占位黑屏当截图发出去；常驻时用帧环取"按下前"的帧。

## 3. 文件

| 文件 | 作用 |
|---|---|
| `daemon/dshshotd.cpp` | **常驻进程**：全局热键、帧环预录、清保护、采集、PNG，一条 JSON 行输出；`--bench N` 可测延迟 |
| `shotcap/shotcap.cpp` | 采集库 + CLI：`--mode screen\|desktop\|window`、`--backend auto\|gdi\|dxgi\|printwindow`、`--crop`、`--selftest-wda`、`--hold`（daemon 直接复用它） |
| `wda/wdaclear.cpp` | 枚举带保护的窗口；本进程的直接清，跨进程的注入 payload |
| `wda/wdapay.cpp` | 注入到目标进程的 DLL：扫本进程顶层窗口，把非 0 的 affinity 清成 0，并在 8 秒内反复扫（客户端常在重绘/切换标签时重新加保护） |
| `kdrv/dshshot.c` | WDM 驱动：`IOCTL_DSHSHOT_CLEAR` / `_GUARD` / `_STATUS`；用内核句柄打开目标进程并在其中创建线程 |
| `kdrv/dshcapctl.cpp` | 驱动的用户态前端：`--status` / `--clear [--guard N]` |
| `kdrv/install.ps1` | 注册/卸载服务；必要时打开 `testsigning` 并明确告诉你还需重启 |
| `build-all.ps1` | 全部编译，产物复制进插件 `bin/` |
| `test-wda.ps1` | 回归测试：造一个 `WDA_EXCLUDEFROMCAPTURE` 窗口，验证清标志前后画面确实变了 |
| `test-daemon.ps1` | 回归测试：daemon 连拍 5 张，断言全部走 ring、平均延迟 < 150 ms、文件真的落盘 |
| `test-modes.ps1` | 回归测试：窗口级抓取 + JPEG，断言只截到 520×340 的窗口而不是整屏 |

## 4. 编译

```powershell
# 采集 + 用户态清除（不需要 WDK）
pwsh -File capture/build-all.ps1

# 连同内核驱动（需要 WDK 头文件/库；本仓库支持 NuGet 版 WDK）
pwsh -File capture/build-all.ps1 -Kernel
```

工具链来源：
- MSVC：`C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat`
- WDK：优先 `%USERPROFILE%\.dsh\kdrv-toolchain\wdk\c`（`Microsoft.Windows.WDK.x64` NuGet 包解压），
  其次 `C:\Program Files (x86)\Windows Kits\10`。

## 5. 装驱动（可选）

```powershell
# 管理员
pwsh -File capture/kdrv/install.ps1
# 若提示已打开 testsigning：重启后
sc start dshshot
.\bin\dshcapctl.exe --status
```

没有签名证书时，Windows 只在放宽签名校验（`bcdedit /set testsigning on`）后加载这个驱动；
`install.ps1` 会打开它并把"仍需重启"说清楚，不会假装已经能用。不想动内核就跳过这一步，
用户态那层已经覆盖大多数客户端。

## 6. 边界（写清楚，免得误判）

- **DRM / OPM 保护的内容**（Netflix、PlayReady、部分银行控件、HDCP 链路）：像素在驱动层就被
  替换掉，清 affinity 也没用，只有硬件采集卡能解决。
- **保护进程 / 反作弊**：驱动能否打开进程取决于对方是否 PPL/受保护；失败会返回具体 NTSTATUS，
  写进 `bridge.log`，截图仍会照常发出（可能是占位画面）。
- **32 位目标进程**：payload 只能注入同位数进程；驱动明确拒绝 WOW64 目标（`STATUS_NOT_SUPPORTED`）。
- **清掉别人窗口的保护是全局副作用**：默认只清前台窗口；`wdaclear --clear` 不带 `--target`
  会清全部，本地调试可以，日常别这么用。
- 多屏用 DXGI 逐 output 抓取后按桌面坐标拼；旋转屏暂不特殊处理（会走 GDI 兜底）。

## 7. 实测记录（本机 Windows 11 26200 / AMD RX 7700 XT）

```
PS> .\bin\shotcap.exe --selftest-wda --wda none
{"gdi":{"lit":1.0,"mean":137.19},"dxgi":{"lit":1.0,"mean":137.19},"printwindow":{"lit":1.0,"mean":136.53}}
PS> .\bin\shotcap.exe --selftest-wda --wda monitor
{"gdi":{"lit":0.0,"mean":0.00},"dxgi":{"lit":0.0,"mean":0.00},"printwindow":{"lit":0.0,"mean":0.00}}
PS> .\bin\shotcap.exe --selftest-wda --wda exclude
{"gdi":{"lit":1.0,"mean":249.08},"dxgi":{"lit":1.0,"mean":249.08},"printwindow":{"lit":0.0,"mean":0.00}}
PS> pwsh -File .\test-wda.ps1
{"kind":"capture-regression","pass":true,"cleared":1,"before":21.5,"after":135.83,"delta":114.3,"backend":"gdi"}

PS> pwsh -File .\test-daemon.ps1
{"kind":"daemon-regression","pass":true,"captures":5,"files":5,"ringUsed":5,
 "avgMs":46,"minMs":45,"backends":["ring","ring","ring","ring","ring"],
 "lagMs":[28,78,123,169,215]}

PS> .\bin\dshshotd.exe --bench 6 --outdir .\testout --clear --prebuffer 600 --prelag 250
{"kind":"bench","count":6,"avgMs":63,"minMs":44}      # 旧链路 hotkey.ps1 -DryRun: 489 ms
```

`exclude` 那行里 gdi/dxgi 的 249 不是窗口内容，而是**窗口消失后露出的背后画面**——所以
"黑屏检测"只能挡住 `WDA_MONITOR`，`WDA_EXCLUDEFROMCAPTURE` 必须靠查 affinity 判断。这正是
`hotkey.ps1` 里先 `GetWindowDisplayAffinity(GetForegroundWindow())` 再决定要不要清的原因。


