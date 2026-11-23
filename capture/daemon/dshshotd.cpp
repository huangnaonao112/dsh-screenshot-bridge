// dshshotd — resident screenshot daemon for dsh-screenshot-bridge.
//
// Replaces the old "hotkey.ps1 + shotcap.exe per press" chain with one process
// that lives as long as the Host does:
//
//   * registers the global hotkey / mouse trigger itself (no PowerShell, no
//     WinForms, no per-press process creation)
//   * keeps a DXGI desktop duplication open and a short ring of recent frames,
//     so pressing the key yields the frame from *before* the client noticed the
//     focus change (many proctored clients wipe the window on focus loss)
//   * clears the foreground window's SetWindowDisplayAffinity without loading a
//     DLL into the target: the same remote-thread stub the kernel driver uses,
//     so no module shows up in the target's module list
//   * writes the PNG and reports one NDJSON line, exactly like the old helper
//
// Usage:
//   dshshotd --hotkey Alt+Z --outdir DIR [--backend auto|gdi|dxgi]
//            [--all-screens] [--clear] [--prebuffer 600] [--prelag 250]
//            [--bench 5] [--dry-run]
//
// stdout (NDJSON):
//   {"kind":"ready","hotkey":"Alt+Z","prebuffer":600}
//   {"kind":"capture","backend":"ring","path":"...","width":...,"height":...,
//    "blank":false,"lit":0.7,"mean":96,"lag":243,"ms":38,"cleared":1}

#define SHOTCAP_NO_MAIN
#include "../shotcap/shotcap.cpp"

#include <atomic>
#include <cstdint>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

#ifndef WDA_MONITOR
#define WDA_MONITOR 0x00000001
#endif
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif
#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif

// ---------------------------------------------------------------- helpers

static int64_t NowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// JPEG path: WIC's PNG encoder costs ~35 ms at 1440p; the JPEG one costs a
// fraction of that. Text survives q95 fine, and the Host/OCR side reads both.
static bool SaveJpeg(const Frame& frame, const std::wstring& path, int quality, std::string& err) {
    if (frame.width <= 0 || frame.height <= 0 || frame.bgra.empty()) {
        err = "empty frame";
        return false;
    }
    ComPtr<IWICImagingFactory> factory;
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
        err = "wic factory " + HrText(hr);
        return false;
    }
    ComPtr<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream)) ||
        FAILED(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE))) {
        err = "wic open";
        return false;
    }
    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder)) ||
        FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) {
        err = "wic encoder";
        return false;
    }
    ComPtr<IWICBitmapFrameEncode> frameEncode;
    ComPtr<IPropertyBag2> props;
    if (FAILED(encoder->CreateNewFrame(&frameEncode, &props))) {
        err = "wic frame";
        return false;
    }
    if (props != nullptr) {
        PROPBAG2 option = {};
        option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        VARIANT value = {};
        value.vt = VT_R4;
        value.fltVal = static_cast<float>(quality <= 0 ? 95 : quality) / 100.0f;
        props->Write(1, &option, &value);
    }
    if (FAILED(frameEncode->Initialize(props.Get())) ||
        FAILED(frameEncode->SetSize(static_cast<UINT>(frame.width), static_cast<UINT>(frame.height)))) {
        err = "wic init";
        return false;
    }
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    if (FAILED(frameEncode->SetPixelFormat(&format))) {
        err = "wic format";
        return false;
    }
    const UINT stride = static_cast<UINT>(frame.width) * 4;
    ComPtr<IWICBitmap> bitmap;
    if (FAILED(factory->CreateBitmapFromMemory(static_cast<UINT>(frame.width),
                                               static_cast<UINT>(frame.height),
                                               GUID_WICPixelFormat32bppBGRA, stride,
                                               static_cast<UINT>(frame.bgra.size()),
                                               const_cast<BYTE*>(frame.bgra.data()), &bitmap))) {
        err = "wic bitmap";
        return false;
    }
    ComPtr<IWICFormatConverter> converter;
    if (FAILED(factory->CreateFormatConverter(&converter)) ||
        FAILED(converter->Initialize(bitmap.Get(), format, WICBitmapDitherTypeNone, nullptr, 0.0,
                                     WICBitmapPaletteTypeCustom))) {
        err = "wic convert";
        return false;
    }
    if (FAILED(frameEncode->WriteSource(converter.Get(), nullptr)) ||
        FAILED(frameEncode->Commit()) || FAILED(encoder->Commit())) {
        err = "wic write";
        return false;
    }
    return true;
}
static void EmitLine(const std::string& line) {
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

static void EmitError(const std::string& message) {
    EmitLine("{\"kind\":\"error\",\"message\":\"" + JsonEscape(message) + "\"}");
}

static std::wstring ExeDirectory() {
    wchar_t self[MAX_PATH] = {};
    DWORD len = GetModuleFileNameW(nullptr, self, MAX_PATH);
    std::wstring path(self, len);
    size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

/// Create every missing component; CreateDirectoryW alone only makes one level.
static bool EnsureDirectory(const std::wstring& path) {
    if (path.empty()) return false;
    if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return true;
    std::wstring current;
    for (size_t i = 0; i < path.size(); ++i) {
        current += path[i];
        if (i + 1 != path.size()) continue;
        CreateDirectoryW(current.c_str(), nullptr);
    }
    return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

struct Options {
    std::string hotkey = "Alt+Z";
    std::wstring outDir;
    std::string backend = "auto";
    std::string target = "auto";   // auto | window | screen
    std::string format = "png";    // png | jpg
    int quality = 95;
    unsigned long long hwnd = 0;
    bool allScreens = false;
    bool clear = true;
    int prebufferMs = 600;
    int prelagMs = 250;
    int bench = 0;
    bool dryRun = false;
};

// ---------------------------------------------------------------- remote thread stub

/// Calls SetWindowDisplayAffinity(hwnd, WDA_NONE) from inside the owning
/// process without mapping a module there. user32/kernel32 are KnownDLLs, so
/// their addresses are identical in every 64-bit process.
static bool ClearAffinityStub(HWND hwnd, std::string& why) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0 || pid == 4) {
        why = "system-process";
        return false;
    }
    if (pid == GetCurrentProcessId()) {
        SetWindowDisplayAffinity(hwnd, WDA_NONE);
        DWORD now = 1;
        GetWindowDisplayAffinity(hwnd, &now);
        if (now == WDA_NONE) return true;
        why = "in-process-refused";
        return false;
    }

    HANDLE probe = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (probe == nullptr) {
        why = "query-denied " + std::to_string(GetLastError());
        return false;
    }
    USHORT machine = 0;
    USHORT native = 0;
    bool ok = true;
    if (IsWow64Process2(probe, &machine, &native)) {
        if (machine == IMAGE_FILE_MACHINE_I386) {
            ok = false;
            why = "arch-x86";
        }
    }
    CloseHandle(probe);
    if (!ok) return false;

    HANDLE process = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
                                     PROCESS_QUERY_INFORMATION,
                                 FALSE, pid);
    if (process == nullptr) {
        why = "open-denied " + std::to_string(GetLastError());
        return false;
    }

    FARPROC setAffinity = GetProcAddress(GetModuleHandleW(L"user32.dll"),
                                         "SetWindowDisplayAffinity");
    FARPROC exitThread = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "ExitThread");
    if (setAffinity == nullptr || exitThread == nullptr) {
        CloseHandle(process);
        why = "resolve-failed";
        return false;
    }

    // sub rsp,28h / mov rcx,hwnd / xor edx,edx / mov rax,setAffinity / call rax
    // xor ecx,ecx / mov rax,ExitThread / call rax / add rsp,28h / ret
    std::vector<uint8_t> stub;
    auto push = [&](const void* data, size_t size) {
        const uint8_t* bytes = static_cast<const uint8_t*>(data);
        stub.insert(stub.end(), bytes, bytes + size);
    };
    const uint8_t prefix[] = {0x48, 0x83, 0xEC, 0x28, 0x48, 0xB9};
    push(prefix, sizeof(prefix));
    uintptr_t window = reinterpret_cast<uintptr_t>(hwnd);
    push(&window, sizeof(window));
    const uint8_t zeroDx[] = {0x31, 0xD2, 0x48, 0xB8};
    push(zeroDx, sizeof(zeroDx));
    uintptr_t fnSet = reinterpret_cast<uintptr_t>(setAffinity);
    push(&fnSet, sizeof(fnSet));
    const uint8_t callExit[] = {0xFF, 0xD0, 0x31, 0xC9, 0x48, 0xB8};
    push(callExit, sizeof(callExit));
    uintptr_t fnExit = reinterpret_cast<uintptr_t>(exitThread);
    push(&fnExit, sizeof(fnExit));
    const uint8_t tail[] = {0xFF, 0xD0, 0x48, 0x83, 0xC4, 0x28, 0xC3};
    push(tail, sizeof(tail));

    void* remote = VirtualAllocEx(process, nullptr, stub.size(), MEM_COMMIT | MEM_RESERVE,
                                  PAGE_EXECUTE_READWRITE);
    if (remote == nullptr) {
        why = "alloc-denied " + std::to_string(GetLastError());
        CloseHandle(process);
        return false;
    }
    SIZE_T written = 0;
    if (!WriteProcessMemory(process, remote, stub.data(), stub.size(), &written)) {
        why = "write-denied " + std::to_string(GetLastError());
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);
        return false;
    }

    HANDLE thread = CreateRemoteThread(process, nullptr, 0,
                                       reinterpret_cast<LPTHREAD_START_ROUTINE>(remote), nullptr,
                                       0, nullptr);
    if (thread == nullptr) {
        why = "thread-denied " + std::to_string(GetLastError());
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        CloseHandle(process);
        return false;
    }
    DWORD waited = WaitForSingleObject(thread, 1500);
    if (waited == WAIT_TIMEOUT) {
        TerminateThread(thread, 0);
        why = "thread-timeout";
    }
    CloseHandle(thread);
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    CloseHandle(process);

    DWORD affinity = 1;
    GetWindowDisplayAffinity(hwnd, &affinity);
    if (affinity == WDA_NONE) return true;
    if (why.empty()) why = "still-protected";
    return false;
}

struct ClearReport {
    int tried = 0;
    int cleared = 0;
    std::string firstError;
};

/// Clear every protected top-level window of the foreground process.
static ClearReport ClearProcessOf(HWND anchor) {
    ClearReport report;
    if (anchor == nullptr) return report;
    DWORD pid = 0;
    GetWindowThreadProcessId(anchor, &pid);

    struct Ctx {
        DWORD pid;
        ClearReport* report;
    } ctx{pid, &report};

    EnumWindows(
        [](HWND hwnd, LPARAM param) -> BOOL {
            auto* c = reinterpret_cast<Ctx*>(param);
            DWORD owner = 0;
            GetWindowThreadProcessId(hwnd, &owner);
            if (owner != c->pid) return TRUE;
            DWORD affinity = 0;
            if (!GetWindowDisplayAffinity(hwnd, &affinity) || affinity == WDA_NONE) return TRUE;
            c->report->tried += 1;
            std::string why;
            if (ClearAffinityStub(hwnd, why)) {
                c->report->cleared += 1;
            } else if (c->report->firstError.empty()) {
                c->report->firstError = why;
            }
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&ctx));
    return report;
}

// ---------------------------------------------------------------- frame ring

class FrameRing {
public:
    ~FrameRing() { Stop(); }

    bool Start(int prebufferMs, std::string& err) {
        slotCount_ = prebufferMs / 70;
        if (slotCount_ < 4) slotCount_ = 4;
        if (slotCount_ > 18) slotCount_ = 18;
        running_ = true;
        thread_ = std::thread([this] { Run(); });
        // Give it a moment to attach so the first press already has a frame.
        {
            std::unique_lock<std::mutex> lock(mutex_);
            ready_cv_.wait_for(lock, std::chrono::milliseconds(600), [this] { return ready_ || !running_; });
            if (!ready_) {
                err = "ring-not-ready";
                return false;
            }
        }
        // DXGI only delivers a frame when the desktop actually presents. On a
        // static screen the ring would stay empty, so seed it with one GDI
        // frame; real frames replace it as soon as anything repaints.
        SeedFromGdi();
        return true;
    }

    /// Put one live GDI frame into the ring so a press always has something.
    bool SeedFromGdi() {
        Frame frame;
        std::string ignore;
        if (!CaptureGdi(rect_, frame, ignore)) return false;
        std::lock_guard<std::mutex> lock(mutex_);
        if (!slots_.empty()) return true;
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = static_cast<UINT>(frame.width);
        desc.Height = static_cast<UINT>(frame.height);
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        for (int i = 0; i < slotCount_; ++i) {
            ComPtr<ID3D11Texture2D> slot;
            if (FAILED(device_->CreateTexture2D(&desc, nullptr, &slot))) return false;
            slots_.push_back(slot);
        }
        context_->UpdateSubresource(slots_[0].Get(), 0, nullptr, frame.bgra.data(),
                                    static_cast<UINT>(frame.width) * 4, 0);
        times_.assign(slots_.size(), 0);
        times_[0] = NowMs();
        width_ = frame.width;
        height_ = frame.height;
        nextIndex_ = 1 % static_cast<int>(slots_.size());
        hasFrame_ = true;
        ++stored_;
        return true;
    }

    void Stop() {
        running_ = false;
        if (thread_.joinable()) thread_.join();
    }

    bool Active() const { return ready_; }
    int StoredCount() const { return stored_.load(); }
    int AcqCount() const { return acq_.load(); }
    int FrameCount() const { return frames_.load(); }
    long LastHr() const { return lastHr_.load(); }
    std::string LastError() const { return lastError_; }

    /// Frame closest to (now - lagMs) from the ring.
    bool Grab(Frame& out, int lagMs, int64_t* actualLag, std::string& err) {
        std::unique_lock<std::mutex> lock(mutex_);
        if (!hasFrame_) {
            frame_cv_.wait_for(lock, std::chrono::milliseconds(400), [this] { return hasFrame_ || !running_; });
        }
        if (!hasFrame_) {
            err = "ring-empty";
            return false;
        }
        const int64_t target = NowMs() - lagMs;
        int best = -1;
        int64_t bestDelta = INT64_MAX;
        for (size_t i = 0; i < times_.size(); ++i) {
            if (!times_[i]) continue;
            int64_t delta = times_[i] - target;
            if (delta < 0) delta = -delta;
            if (delta < bestDelta) {
                bestDelta = delta;
                best = static_cast<int>(i);
            }
        }
        if (best < 0) {
            err = "ring-empty";
            return false;
        }
        if (staging_ == nullptr || stagingW_ != width_ || stagingH_ != height_) {
            staging_.Reset();
            D3D11_TEXTURE2D_DESC desc = {};
            slots_[best]->GetDesc(&desc);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            desc.MiscFlags = 0;
            if (FAILED(device_->CreateTexture2D(&desc, nullptr, &staging_))) {
                err = "staging-failed";
                return false;
            }
            stagingW_ = width_;
            stagingH_ = height_;
        }
        context_->CopyResource(staging_.Get(), slots_[best].Get());
        D3D11_MAPPED_SUBRESOURCE map = {};
        if (FAILED(context_->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &map))) {
            err = "map-failed";
            return false;
        }
        out.width = width_;
        out.height = height_;
        out.bgra.assign(static_cast<size_t>(width_) * height_ * 4, 0);
        for (int y = 0; y < height_; ++y) {
            const uint8_t* src = static_cast<const uint8_t*>(map.pData) + static_cast<size_t>(y) * map.RowPitch;
            std::memcpy(out.bgra.data() + static_cast<size_t>(y) * width_ * 4, src,
                        static_cast<size_t>(width_) * 4);
        }
        context_->Unmap(staging_.Get(), 0);
        if (actualLag != nullptr) *actualLag = NowMs() - times_[best];
        return true;
    }

private:
    void Run() {
        HRESULT co = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        (void)co;
        std::string err;
        if (!Attach(err)) {
            std::lock_guard<std::mutex> lock(mutex_);
            ready_ = false;
            running_ = false;
            ready_cv_.notify_all();
            CoUninitialize();
            return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ready_ = true;
        }
        ready_cv_.notify_all();

        HMONITOR monitor = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
        int64_t nextCheck = NowMs() + 2000;
        while (running_) {
            DXGI_OUTDUPL_FRAME_INFO info = {};
            ComPtr<IDXGIResource> resource;
            HRESULT hr = dup_->AcquireNextFrame(100, &info, &resource);
            ++acq_;
            lastHr_ = static_cast<long>(hr);
            if (SUCCEEDED(hr)) ++frames_;
            if (SUCCEEDED(hr)) {
                if (info.LastPresentTime.QuadPart != 0) {
                    ComPtr<ID3D11Texture2D> texture;
                    if (SUCCEEDED(resource.As(&texture)) && Store(texture.Get())) {
                        // stored
                    }
                }
                dup_->ReleaseFrame();
            }
            if (NowMs() >= nextCheck) {
                nextCheck = NowMs() + 2000;
                POINT cursor;
                GetCursorPos(&cursor);
                HMONITOR current = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
                if (current != monitor) {
                    monitor = current;
                    std::lock_guard<std::mutex> lock(mutex_);
                    dup_.Reset();
                    slots_.clear();
                    times_.clear();
                    hasFrame_ = false;
                    Attach(err);
                }
            }
        }
        CoUninitialize();
    }

    bool Attach(std::string& err) {
        if (device_ == nullptr) {
            D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
            D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
            HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                           D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 2,
                                           D3D11_SDK_VERSION, &device_, &got, &context_);
            if (FAILED(hr)) {
                err = "d3d11 " + HrText(hr);
                return false;
            }
        }
        ComPtr<IDXGIDevice> dxgiDevice;
        ComPtr<IDXGIAdapter> adapter;
        ComPtr<IDXGIFactory1> factory;
        if (FAILED(device_.As(&dxgiDevice)) || FAILED(dxgiDevice->GetAdapter(&adapter)) ||
            FAILED(adapter->GetParent(IID_PPV_ARGS(&factory)))) {
            err = "dxgi-chain";
            return false;
        }
        POINT cursor;
        GetCursorPos(&cursor);
        HMONITOR monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
        MONITORINFO mi = {sizeof(MONITORINFO)};
        GetMonitorInfoW(monitor, &mi);
        rect_ = mi.rcMonitor;

        for (UINT a = 0;; ++a) {
            ComPtr<IDXGIAdapter1> adapter1;
            if (factory->EnumAdapters1(a, &adapter1) == DXGI_ERROR_NOT_FOUND) break;
            for (UINT o = 0;; ++o) {
                ComPtr<IDXGIOutput> output;
                if (adapter1->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
                DXGI_OUTPUT_DESC od = {};
                if (FAILED(output->GetDesc(&od))) continue;
                if (od.DesktopCoordinates.left != rect_.left || od.DesktopCoordinates.top != rect_.top) continue;
                ComPtr<IDXGIOutput1> output1;
                if (FAILED(output.As(&output1))) continue;
                if (FAILED(output1->DuplicateOutput(device_.Get(), &dup_))) continue;
                return true;
            }
        }
        err = "no-output";
        return false;
    }

    bool Store(ID3D11Texture2D* texture) {
        D3D11_TEXTURE2D_DESC desc = {};
        texture->GetDesc(&desc);
        if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
            lastError_ = "format " + std::to_string(static_cast<int>(desc.Format));
            return false;
        }
        std::lock_guard<std::mutex> lock(mutex_);
        if (slots_.empty()) {
            width_ = static_cast<int>(desc.Width);
            height_ = static_cast<int>(desc.Height);
            D3D11_TEXTURE2D_DESC slotDesc = desc;
            slotDesc.Usage = D3D11_USAGE_DEFAULT;
            slotDesc.BindFlags = 0;
            slotDesc.CPUAccessFlags = 0;
            slotDesc.MiscFlags = 0;
            for (int i = 0; i < slotCount_; ++i) {
                ComPtr<ID3D11Texture2D> slot;
                if (FAILED(device_->CreateTexture2D(&slotDesc, nullptr, &slot))) {
                    lastError_ = "slot-create";
                    return false;
                }
                slots_.push_back(slot);
            }
            times_.assign(slots_.size(), 0);
        }
        const int index = nextIndex_;
        context_->CopyResource(slots_[index].Get(), texture);
        times_[index] = NowMs();
        nextIndex_ = (index + 1) % static_cast<int>(slots_.size());
        hasFrame_ = true;
        ++stored_;
        frame_cv_.notify_all();
        return true;
    }

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> dup_;
    ComPtr<ID3D11Texture2D> staging_;
    int stagingW_ = 0;
    int stagingH_ = 0;
    RECT rect_ = {};
    int width_ = 0;
    int height_ = 0;
    int slotCount_ = 8;
    int nextIndex_ = 0;
    std::vector<ComPtr<ID3D11Texture2D>> slots_;
    std::vector<int64_t> times_;
    std::mutex mutex_;
    std::condition_variable frame_cv_;
    std::condition_variable ready_cv_;
    std::atomic<bool> running_{false};
    bool ready_ = false;
    bool hasFrame_ = false;
    std::atomic<int> stored_{0};
    std::atomic<int> acq_{0};
    std::atomic<int> frames_{0};
    std::atomic<long> lastHr_{0};
    std::string lastError_;
    std::thread thread_;
};

// ---------------------------------------------------------------- control pipe

// The Host (and the LAN page) asks for a capture by writing "shoot" to this
// pipe; the daemon answers "ok" and posts the same message a hotkey press
// would. Fixed name: one daemon per user session is the supported shape.
static HWND g_captureWindow = nullptr;

static DWORD WINAPI PipeThread(LPVOID) {
    const wchar_t* name = L"\\\\.\\pipe\\dshshotd";
    while (g_captureWindow != nullptr) {
        HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX,
                                       PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT, 1,
                                       512, 512, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE) {
            Sleep(500);
            continue;
        }
        BOOL connected = ConnectNamedPipe(pipe, nullptr) ? TRUE : (GetLastError() == ERROR_PIPE_CONNECTED);
        if (connected) {
            char buffer[64] = {};
            DWORD read = 0;
            if (ReadFile(pipe, buffer, sizeof(buffer) - 1, &read, nullptr) && read > 0) {
                std::string line(buffer, read);
                if (line.find("shoot") != std::string::npos && g_captureWindow != nullptr) {
                    PostMessageW(g_captureWindow, WM_APP + 7, 0, 0);
                }
                DWORD written = 0;
                WriteFile(pipe, "ok\n", 3, &written, nullptr);
                FlushFileBuffers(pipe);
            }
        }
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
    }
    return 0;
}

// ---------------------------------------------------------------- hotkey model

struct HotkeySpec {
    std::string raw;
    int modifiers = 0;
    int keyCode = 0;
    std::string mouse;  // XButton1 / XButton2 / MiddleButton / WheelUp / WheelDown / WheelLeft / WheelRight
};

static std::string Lower(std::string text) {
    for (auto& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return text;
}

static HotkeySpec ParseHotkey(const std::string& combo) {
    HotkeySpec spec;
    spec.raw = combo;
    std::vector<std::string> parts;
    size_t start = 0;
    while (true) {
        size_t plus = combo.find('+', start);
        parts.push_back(combo.substr(start, plus == std::string::npos ? std::string::npos : plus - start));
        if (plus == std::string::npos) break;
        start = plus + 1;
    }
    for (size_t i = 0; i + 1 < parts.size(); ++i) {
        std::string token = Lower(parts[i]);
        if (token == "ctrl" || token == "control") spec.modifiers |= 0x0002;
        else if (token == "alt") spec.modifiers |= 0x0001;
        else if (token == "shift") spec.modifiers |= 0x0004;
        else if (token == "win" || token == "meta") spec.modifiers |= 0x0008;
    }
    std::string last = parts.empty() ? "" : Lower(parts.back());
    if (last == "xbutton1" || last == "mouse4" || last == "back") spec.mouse = "XButton1";
    else if (last == "xbutton2" || last == "mouse5" || last == "forward") spec.mouse = "XButton2";
    else if (last == "middle" || last == "middlebutton" || last == "mouse3") spec.mouse = "MiddleButton";
    else if (last == "wheelup" || last == "scrollup") spec.mouse = "WheelUp";
    else if (last == "wheeldown" || last == "scrolldown") spec.mouse = "WheelDown";
    else if (last == "wheelleft" || last == "scrollleft") spec.mouse = "WheelLeft";
    else if (last == "wheelright" || last == "scrollright") spec.mouse = "WheelRight";

    if (spec.mouse.empty()) {
        std::string name = parts.empty() ? "" : parts.back();
        for (auto& c : name) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
        if (name.size() == 1) {
            char c = name[0];
            if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) spec.keyCode = c;
            else if (c == ' ') spec.keyCode = 0x20;
        }
        if (spec.keyCode == 0) {
            struct Entry { const char* name; int code; };
            static const Entry table[] = {
                {"PRINTSCREEN", 0x2C}, {"PRTSC", 0x2C}, {"SCROLLLOCK", 0x91}, {"PAUSE", 0x13},
                {"INSERT", 0x2D}, {"DELETE", 0x2E}, {"DEL", 0x2E}, {"HOME", 0x24}, {"END", 0x23},
                {"PAGEUP", 0x21}, {"PAGEDOWN", 0x22}, {"LEFT", 0x25}, {"UP", 0x26},
                {"RIGHT", 0x27}, {"DOWN", 0x28}, {"SPACE", 0x20}, {"TAB", 0x09},
                {"ENTER", 0x0D}, {"RETURN", 0x0D}, {"BACKSPACE", 0x08}, {"ESC", 0x1B},
                {"ESCAPE", 0x1B}, {"`", 0xC0}, {"BACKQUOTE", 0xC0}, {"-", 0xBD}, {"MINUS", 0xBD},
                {"=", 0xBB}, {"EQUAL", 0xBB}, {"[", 0xDB}, {"]", 0xDD}, {";", 0xBA},
                {"'", 0xDE}, {",", 0xBC}, {"COMMA", 0xBC}, {".", 0xBE}, {"PERIOD", 0xBE},
                {"/", 0xBF}, {"SLASH", 0xBF}, {"\\", 0xDC},
            };
            for (const Entry& entry : table) {
                if (name == entry.name) {
                    spec.keyCode = entry.code;
                    break;
                }
            }
            if (spec.keyCode == 0 && name.size() >= 2 && name[0] == 'F') {
                int number = std::atoi(name.c_str() + 1);
                if (number >= 1 && number <= 24) spec.keyCode = 0x70 + number - 1;
            }
        }
        if (spec.keyCode == 0) throw std::runtime_error("unknown key in hotkey: " + combo);
    }
    return spec;
}

// ---------------------------------------------------------------- daemon

class Daemon {
public:
    explicit Daemon(Options options) : options_(std::move(options)) {}

    int Run() {
        WNDCLASSEXW wc = {sizeof(wc)};
        wc.lpfnWndProc = WindowProc;
        wc.hInstance = GetModuleHandleW(nullptr);
        wc.lpszClassName = L"DshShotDaemonWnd";
        RegisterClassExW(&wc);
        HWND messageWindow = CreateWindowExW(0, wc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE,
                                             nullptr, wc.hInstance, nullptr);
        if (messageWindow == nullptr) return 4;
        messageWindow_ = messageWindow;
        g_captureWindow = messageWindow;
        if (pipeThread_ == nullptr) {
            pipeThread_ = CreateThread(nullptr, 0, PipeThread, nullptr, 0, nullptr);
        }

        std::string ringError;
        if (options_.backend != "gdi" && !options_.allScreens && options_.prebufferMs > 0) {
            if (!ring_.Start(options_.prebufferMs, ringError)) {
                // Ring is an optimisation; live capture still works.
                ringError_ = ringError;
            }
        }

        spec_ = ParseHotkey(options_.hotkey);
        if (spec_.mouse.empty()) {
            // A previous DSH session may still have a helper holding the chord;
            // give it a few seconds to die before reporting failure.
            bool registered = false;
            for (int attempt = 0; attempt < 8 && !registered; ++attempt) {
                registered = RegisterHotKey(messageWindow_, kHotkeyId, spec_.modifiers, spec_.keyCode) != 0;
                if (!registered) Sleep(400);
            }
            if (!registered) {
                EmitError("hotkey registration failed (combination taken or reserved): " + options_.hotkey);
                return 3;
            }
        } else {
            hook_ = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, GetModuleHandleW(nullptr), 0);
            if (hook_ == nullptr) {
                EmitError("mouse hook registration failed: " + options_.hotkey);
                return 3;
            }
        }

        EmitLine("{\"kind\":\"ready\",\"hotkey\":\"" + JsonEscape(options_.hotkey) +
                 "\",\"prebuffer\":" + std::to_string(options_.prebufferMs) +
                 ",\"ring\":\"" + (ring_.Active() ? "on" : ringError_.empty() ? "off" : JsonEscape(ringError_)) +
                 "\"}");

        MSG msg;
        while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        g_captureWindow = nullptr;
        if (hook_ != nullptr) UnhookWindowsHookEx(hook_);
        if (spec_.mouse.empty()) UnregisterHotKey(messageWindow_, kHotkeyId);
        ring_.Stop();
        return 0;
    }

    static Daemon*& Instance() {
        static Daemon* instance = nullptr;
        return instance;
    }

    void Trigger() {
        if (!armed_) return;
        armed_ = false;
        // Never capture inside a low-level hook callback: Windows drops a hook
        // that overruns LowLevelHooksTimeout. Post it to the message loop.
        PostMessageW(messageWindow_, kCaptureMessage, 0, 0);
        ArmOnRelease();
    }

    void ArmOnRelease() {
        if (!spec_.mouse.empty() && spec_.mouse.rfind("Wheel", 0) == 0) {
            wheelReadyAt_ = NowMs() + 600;
            return;
        }
        if (spec_.mouse.empty()) {
            releasePollStart_ = NowMs();
            SetTimer(messageWindow_, kReleaseTimer, 25, nullptr);
            return;
        }
        // Side buttons: the hook rearms on button-up.
    }

    bool IsTriggerDown() const {
        if (spec_.mouse == "XButton1") return Down(0x05);
        if (spec_.mouse == "XButton2") return Down(0x06);
        if (spec_.mouse == "MiddleButton") return Down(0x04);
        if (!spec_.mouse.empty()) return false;
        return spec_.keyCode != 0 && Down(spec_.keyCode);
    }

    bool ModifiersMatch() const {
        bool wantCtrl = (spec_.modifiers & 0x0002) != 0;
        bool wantAlt = (spec_.modifiers & 0x0001) != 0;
        bool wantShift = (spec_.modifiers & 0x0004) != 0;
        bool wantWin = (spec_.modifiers & 0x0008) != 0;
        return Down(0x11) == wantCtrl && Down(0x12) == wantAlt && Down(0x10) == wantShift &&
               (Down(0x5B) || Down(0x5C)) == wantWin;
    }

    void OnHotkeyMessage() { Trigger(); }

    void OnTimer(UINT_PTR id) {
        if (id != kReleaseTimer) return;
        if (!IsTriggerDown()) {
            KillTimer(messageWindow_, kReleaseTimer);
            armed_ = true;
            return;
        }
        if (NowMs() - releasePollStart_ > 5000) {
            KillTimer(messageWindow_, kReleaseTimer);
            armed_ = true;
        }
    }

    void OnMouse(WPARAM wparam) {
        const UINT msg = static_cast<UINT>(wparam);
        std::string action;
        if (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP) {
            // Read the button id from the hook data (delivered by MouseProc).
            action = lastMouseAction_;
        } else if (msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL) {
            action = lastMouseAction_;
        }
        if (action.empty() || action != spec_.mouse) return;
        if (!ModifiersMatch()) return;
        if (NowMs() < wheelReadyAt_) return;
        Trigger();
    }

    void SetLastMouse(const std::string& action) { lastMouseAction_ = action; }

    bool WheelCooling() const { return NowMs() < wheelReadyAt_; }

private:
    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static LRESULT CALLBACK MouseProc(int code, WPARAM wparam, LPARAM lparam) {
        if (code >= 0) {
            Daemon* self = Instance();
            if (self != nullptr) {
                auto* data = reinterpret_cast<MSLLHOOKSTRUCT*>(lparam);
                const UINT msg = static_cast<UINT>(wparam);
                std::string action;
                const int high = static_cast<int>((data->mouseData >> 16) & 0xFFFF);
                if (msg == WM_XBUTTONDOWN) {
                    action = high == 1 ? "XButton1" : high == 2 ? "XButton2" : "";
                } else if (msg == WM_XBUTTONUP) {
                    std::string released = high == 1 ? "XButton1" : high == 2 ? "XButton2" : "";
                    if (!released.empty() && released == self->spec_.mouse) {
                        self->armed_ = true;
                        return 1;
                    }
                    return CallNextHookEx(self->hook_, code, wparam, lparam);
                } else if (msg == WM_MOUSEWHEEL) {
                    action = high > 0 ? "WheelUp" : high < 0 ? "WheelDown" : "";
                } else if (msg == WM_MOUSEHWHEEL) {
                    action = high > 0 ? "WheelRight" : high < 0 ? "WheelLeft" : "";
                }
                if (!action.empty()) {
                    self->lastMouseAction_ = action;
                    self->OnMouse(wparam);
                    if (action == self->spec_.mouse && (msg == WM_XBUTTONDOWN)) return 1;
                }
            }
        }
        Daemon* self = Instance();
        return CallNextHookEx(self == nullptr ? nullptr : self->hook_, code, wparam, lparam);
    }

    static LRESULT CALLBACK WindowProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
        Daemon* self = Instance();
        if (self == nullptr) return DefWindowProcW(hwnd, msg, wparam, lparam);
        if (msg == WM_HOTKEY && static_cast<int>(wparam) == kHotkeyId) {
            self->OnHotkeyMessage();
            return 0;
        }
        if (msg == kCaptureMessage) {
            self->CaptureNow();
            return 0;
        }
        if (msg == WM_TIMER) {
            self->OnTimer(wparam);
            return 0;
        }
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

public:
    static WNDPROC Proc() { return WindowProc; }

    /// Capture once, exactly like a hotkey press would, but synchronously.
    void CaptureNow() { Capture(); }

    /// Measure N presses end to end (clear + frame + PNG encode).
    void Benchmark(int count) {
        std::string ringError;
        if (options_.backend != "gdi" && !options_.allScreens && options_.prebufferMs > 0) {
            if (!ring_.Start(options_.prebufferMs, ringError)) ringError_ = ringError;
        }
        EmitLine("{\"kind\":\"bench-start\",\"ring\":\"" +
                 std::string(ring_.Active() ? "on" : JsonEscape(ringError_)) + "\"}");
        int64_t minMs = INT64_MAX;
        int64_t sum = 0;
        for (int i = 0; i < count; ++i) {
            int64_t start = NowMs();
            Capture();
            int64_t delta = NowMs() - start;
            sum += delta;
            if (delta < minMs) minMs = delta;
        }
        ring_.Stop();
        int n = count > 0 ? count : 1;
        EmitLine("{\"kind\":\"bench\",\"count\":" + std::to_string(count) +
                 ",\"avgMs\":" + std::to_string(sum / n) + ",\"minMs\":" + std::to_string(minMs) + "}");
    }

private:
    void Capture() {
        const int64_t start = NowMs();
        const int64_t triggeredAt = start;
        HWND anchor = options_.hwnd != 0
            ? reinterpret_cast<HWND>(static_cast<uintptr_t>(options_.hwnd))
            : GetForegroundWindow();
        bool wasProtected = false;
        if (anchor != nullptr) {
            DWORD affinity = 0;
            if (GetWindowDisplayAffinity(anchor, &affinity)) wasProtected = affinity != WDA_NONE;
        }
        ClearReport clear;
        if (options_.clear) clear = ClearProcessOf(anchor);

        Frame frame;
        std::string backend;
        std::string target = "screen";
        std::string error;
        int64_t lag = -1;

        // Window mode: after the flag is gone, PrintWindow renders the window
        // itself, so occlusion and off-screen parts stop mattering and the PNG
        // is only the window instead of a whole monitor.
        const bool wantWindow = !options_.allScreens && anchor != nullptr &&
            (options_.hwnd != 0 || options_.target == "window" ||
             (options_.target == "auto" && wasProtected));
        if (wantWindow) {
            std::string printError;
            if (CapturePrintWindow(anchor, frame, printError)) {
                Stats probe = Analyze(frame);
                if (probe.lit > 0.0005) {
                    backend = "printwindow";
                    target = "window";
                } else {
                    frame.bgra.clear();
                    error = "printwindow-blank";
                }
            } else {
                error = printError;
            }
        }

        if (frame.bgra.empty() && options_.allScreens) {
            struct Capture liveShot = RunAuto("desktop", DesktopRect(), nullptr);
            if (liveShot.ok) {
                frame = std::move(liveShot.frame);
                backend = liveShot.backend;
            } else {
                error = liveShot.error;
            }
        } else if (frame.bgra.empty() && wasProtected) {
            // The buffered frame predates the clear and therefore still shows a
            // placeholder. Take a live frame now that the flag is gone; only if
            // that comes back blank (the client wipes itself on focus loss, or
            // the clear did not take) fall back to the ring.
            RECT rect = ScreenRect();
            std::string gdiError;
            if (CaptureGdi(rect, frame, gdiError)) {
                backend = "gdi-live";
                Stats probe = Analyze(frame);
                if (probe.lit <= 0.0005 && ring_.Active()) {
                    Frame buffered;
                    int64_t bufferedLag = -1;
                    std::string ringError;
                    if (ring_.Grab(buffered, options_.prelagMs, &bufferedLag, ringError)) {
                        Stats bufferedStats = Analyze(buffered);
                        if (bufferedStats.lit > probe.lit) {
                            frame = std::move(buffered);
                            backend = "ring-pre";
                            lag = bufferedLag;
                        }
                    }
                }
            } else if (error.empty()) {
                error = gdiError;
            }
        } else if (frame.bgra.empty() && ring_.Active()) {
            if (ring_.Grab(frame, options_.prelagMs, &lag, error)) {
                backend = "ring";
            }
        }
        if (frame.bgra.empty()) {
            RECT rect = ScreenRect();
            std::string gdiError;
            if (CaptureGdi(rect, frame, gdiError)) {
                backend = backend.empty() ? (error.empty() ? "gdi" : "gdi[" + error + "]") : backend + "+gdi";
                lag = -1;
            } else if (error.empty()) {
                error = gdiError;
            }
        }
        (void)triggeredAt;
        if (frame.bgra.empty()) {
            EmitError("capture failed: " + (error.empty() ? "no frame" : error));
            return;
        }

        SYSTEMTIME st;
        GetLocalTime(&st);
        const bool jpeg = options_.format == "jpg" || options_.format == "jpeg";
        wchar_t name[64];
        swprintf_s(name, jpeg ? L"shot-%04d%02d%02d-%02d%02d%02d-%03d.jpg"
                              : L"shot-%04d%02d%02d-%02d%02d%02d-%03d.png",
                   st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);

        // The Host's preferred directory is tried first. A sandboxed process can
        // be denied outside its workspace, so fall back to directories beside the
        // daemon and report where the file really landed.
        std::vector<std::wstring> dirs;
        if (!options_.outDir.empty()) dirs.push_back(options_.outDir);
        const std::wstring exeDir = ExeDirectory();
        dirs.push_back(exeDir + L"\\.shots");
        dirs.push_back(exeDir + L"\\..\\.dsh-shots");

        std::wstring path;
        std::string saveError = "no writable directory";
        bool saved = false;
        for (const std::wstring& dir : dirs) {
            if (!EnsureDirectory(dir)) continue;
            std::wstring candidate = dir + L"\\" + name;
            std::string attemptError;
            const bool ok = jpeg ? SaveJpeg(frame, candidate, options_.quality, attemptError)
                                 : SavePng(frame, candidate, attemptError);
            if (ok) {
                path = candidate;
                saved = true;
                break;
            }
            saveError = attemptError;
        }
        if (!saved) {
            EmitError("save failed: " + saveError);
            return;
        }
        Stats stats = Analyze(frame);
        std::string line = "{\"kind\":\"capture\",\"backend\":\"" + JsonEscape(backend) +
                           "\",\"path\":\"" + JsonEscape(Utf8(path)) + "\",\"savedIn\":\"" + JsonEscape(Utf8(ExeDirectory())) + "\",\"target\":\"" + target +
                           "\",\"format\":\"" + (jpeg ? "jpg" : "png") +
                           "\",\"width\":" + std::to_string(frame.width) + ",\"height\":" + std::to_string(frame.height) +
                           ",\"blank\":" + (stats.lit <= 0.0005 ? "true" : "false") +
                           ",\"lit\":" + std::to_string(stats.lit) +
                           ",\"mean\":" + std::to_string(stats.mean) +
                           ",\"lag\":" + std::to_string(lag) +
                           ",\"ms\":" + std::to_string(NowMs() - start) +
                           ",\"cleared\":" + std::to_string(clear.cleared) +
                           ",\"ringStored\":" + std::to_string(ring_.StoredCount()) +
                           ",\"acq\":" + std::to_string(ring_.AcqCount()) +
                           ",\"frames\":" + std::to_string(ring_.FrameCount()) +
                           ",\"hr\":" + std::to_string(ring_.LastHr());
        if (!ring_.LastError().empty()) line += ",\"ringErr\":\"" + JsonEscape(ring_.LastError()) + "\"";
        if (!clear.firstError.empty()) line += ",\"clearError\":\"" + JsonEscape(clear.firstError) + "\"";
        line += "}";
        EmitLine(line);
    }

    static bool DirectoryExists(const std::wstring& path) {
        DWORD attributes = GetFileAttributesW(path.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    }

    static constexpr int kHotkeyId = 0x445348;
    static constexpr UINT kCaptureMessage = WM_APP + 7;
    static constexpr UINT_PTR kReleaseTimer = 1;

    Options options_;
    HotkeySpec spec_;
    FrameRing ring_;
    std::string ringError_;
    HWND messageWindow_ = nullptr;
    HHOOK hook_ = nullptr;
    HANDLE pipeThread_ = nullptr;
    bool armed_ = true;
    int64_t wheelReadyAt_ = 0;
    int64_t releasePollStart_ = 0;
    std::string lastMouseAction_;

public:
    static void Install(Daemon* daemon) { Instance() = daemon; }
};

// ---------------------------------------------------------------- entry

int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    Options options;
    for (int i = 1; i < argc; ++i) {
        std::string arg = Utf8(argv[i]);
        auto next = [&](std::string& dst) {
            if (i + 1 < argc) dst = Utf8(argv[++i]);
        };
        if (arg == "--hotkey") {
            next(options.hotkey);
        } else if (arg == "--outdir") {
            if (i + 1 < argc) options.outDir = argv[++i];
        } else if (arg == "--backend") {
            next(options.backend);
        } else if (arg == "--target") {
            next(options.target);
        } else if (arg == "--format") {
            next(options.format);
        } else if (arg == "--hwnd") {
            std::string value;
            next(value);
            options.hwnd = std::wcstoull(std::wstring(value.begin(), value.end()).c_str(), nullptr, 16);
        } else if (arg == "--quality") {
            std::string value;
            next(value);
            options.quality = std::atoi(value.c_str());
        } else if (arg == "--all-screens") {
            options.allScreens = true;
        } else if (arg == "--clear") {
            options.clear = true;
        } else if (arg == "--no-clear") {
            options.clear = false;
        } else if (arg == "--prebuffer") {
            std::string value;
            next(value);
            options.prebufferMs = std::atoi(value.c_str());
        } else if (arg == "--prelag") {
            std::string value;
            next(value);
            options.prelagMs = std::atoi(value.c_str());
        } else if (arg == "--bench") {
            std::string value;
            next(value);
            options.bench = std::atoi(value.c_str());
            if (options.bench <= 0) options.bench = 3;
        } else if (arg == "--help" || arg == "-h") {
            std::printf("dshshotd --hotkey ALT+Z --outdir DIR [--backend auto|gdi|dxgi] [--all-screens]\n"
                        "         [--no-clear] [--prebuffer MS] [--prelag MS]\n");
            CoUninitialize();
            return 0;
        }
    }

    if (options.outDir.empty()) {
        EmitError("missing --outdir");
        CoUninitialize();
        return 2;
    }

    Daemon daemon(options);
    Daemon::Install(&daemon);
    if (options.bench > 0) {
        daemon.Benchmark(options.bench);
        Daemon::Install(nullptr);
        CoUninitialize();
        return 0;
    }
    int code = daemon.Run();
    Daemon::Install(nullptr);
    CoUninitialize();
    return code;
}




















