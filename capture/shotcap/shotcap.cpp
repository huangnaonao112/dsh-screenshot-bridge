// shotcap — screen / window capture helper for dsh-screenshot-bridge.
//
// Backends, in ascending order of "how far below the API surface" they sit:
//
//   gdi          GetDC(NULL) + BitBlt(SRCCOPY|CAPTUREBLT)      — what the old
//                PowerShell helper did. Blocked by any window that owns
//                WS_EX_.../SetWindowDisplayAffinity(WDA_*): the DWM paints the
//                window into the capture path as opaque black.
//   printwindow  PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT) — asks the window
//                itself to render. Not part of the DWM capture path, so windows
//                that only set a display affinity usually still render.
//   dxgi         IDXGIOutput1::DuplicateOutput — reads the DWM-composited
//                desktop surface. Sees through WDA_MONITOR windows (the
//                pre-2004 protection level) and through everything that never
//                called SetWindowDisplayAffinity at all.
//
// WDA_EXCLUDEFROMCAPTURE (Win10 2004+) is enforced inside the compositor, so
// none of the three see those pixels. That is what capture/kdrv is for: the
// driver clears the affinity bit in the window object, after which gdi/dxgi see
// the real content again. shotcap itself never touches the kernel.
//
// Every capture reports how much of the frame is actually lit. A frame that is
// uniformly black almost always means "the compositor gave us a placeholder",
// which is what the Host uses to decide whether to escalate a backend.
//
// Usage:
//   shotcap.exe --out PATH [--mode screen|desktop] [--backend auto|gdi|dxgi|printwindow]
//               [--hwnd 0x1234] [--json]
//   shotcap.exe --selftest-wda [--wda none|monitor|exclude]
//
// machine-readable line (always the last stdout line):
//   {"kind":"capture","backend":"dxgi","path":"...","width":1920,"height":1080,
//    "blank":false,"lit":0.71,"mean":96.4,"error":null}

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

#ifndef PW_RENDERFULLCONTENT
#define PW_RENDERFULLCONTENT 0x00000002
#endif
#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif
#ifndef WDA_MONITOR
#define WDA_MONITOR 0x00000001
#endif
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

// ---------------------------------------------------------------- utilities

static std::string HrText(HRESULT hr) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

static std::string JsonEscape(const std::string& in) {
    std::string out;
    for (char c : in) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"': out += "\\\""; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char esc[8];
                    std::snprintf(esc, sizeof(esc), "\\u%04X", static_cast<unsigned char>(c));
                    out += esc;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

static std::string Utf8(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int need = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                   nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(need), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                        out.data(), need, nullptr, nullptr);
    return out;
}

static bool g_debug = false;
#define DBG(...) do { if (g_debug) { std::fprintf(stderr, __VA_ARGS__); std::fflush(stderr); } } while (0)

struct Frame {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> bgra;  // top-down, 4 bytes/pixel
};

struct Stats {
    double lit = 0.0;   // fraction of pixels with any colour channel > 8
    double mean = 0.0;  // mean of (r+g+b)/3 over all pixels
};

static Stats Analyze(const Frame& frame) {
    Stats s;
    if (frame.bgra.empty()) return s;
    const size_t pixels = frame.bgra.size() / 4;
    double sum = 0.0;
    size_t lit = 0;
    for (size_t i = 0; i < pixels; ++i) {
        const uint8_t b = frame.bgra[i * 4 + 0];
        const uint8_t g = frame.bgra[i * 4 + 1];
        const uint8_t r = frame.bgra[i * 4 + 2];
        if (r > 8 || g > 8 || b > 8) ++lit;
        sum += (static_cast<double>(r) + g + b) / 3.0;
    }
    s.lit = static_cast<double>(lit) / static_cast<double>(pixels);
    s.mean = sum / static_cast<double>(pixels);
    return s;
}

static bool SavePng(const Frame& frame, const std::wstring& path, std::string& err) {
    if (frame.width <= 0 || frame.height <= 0) {
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
    hr = factory->CreateStream(&stream);
    if (FAILED(hr)) {
        err = "wic stream " + HrText(hr);
        return false;
    }
    hr = stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE);
    if (FAILED(hr)) {
        err = "wic open " + HrText(hr);
        return false;
    }
    ComPtr<IWICBitmapEncoder> encoder;
    hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
    if (FAILED(hr)) {
        err = "wic encoder " + HrText(hr);
        return false;
    }
    hr = encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache);
    if (FAILED(hr)) {
        err = "wic encoder init " + HrText(hr);
        return false;
    }
    ComPtr<IWICBitmapFrameEncode> frameEncode;
    ComPtr<IPropertyBag2> props;
    hr = encoder->CreateNewFrame(&frameEncode, &props);
    if (FAILED(hr)) {
        err = "wic frame " + HrText(hr);
        return false;
    }
    hr = frameEncode->Initialize(props.Get());
    if (FAILED(hr)) {
        err = "wic frame init " + HrText(hr);
        return false;
    }
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    hr = frameEncode->SetPixelFormat(&format);
    if (FAILED(hr)) {
        err = "wic format " + HrText(hr);
        return false;
    }
    hr = frameEncode->SetSize(static_cast<UINT>(frame.width), static_cast<UINT>(frame.height));
    if (FAILED(hr)) {
        err = "wic size " + HrText(hr);
        return false;
    }
    const UINT stride = static_cast<UINT>(frame.width) * 4;
    const UINT size = static_cast<UINT>(frame.bgra.size());
    hr = frameEncode->WritePixels(static_cast<UINT>(frame.height), stride, size,
                                  const_cast<BYTE*>(frame.bgra.data()));
    if (FAILED(hr)) {
        err = "wic write " + HrText(hr);
        return false;
    }
    hr = frameEncode->Commit();
    if (FAILED(hr)) {
        err = "wic frame commit " + HrText(hr);
        return false;
    }
    hr = encoder->Commit();
    if (FAILED(hr)) {
        err = "wic commit " + HrText(hr);
        return false;
    }
    return true;
}

// ---------------------------------------------------------------- gdi

static bool CaptureGdi(const RECT& rect, Frame& out, std::string& err) {
    const int w = rect.right - rect.left;
    const int h = rect.bottom - rect.top;
    if (w <= 0 || h <= 0) {
        err = "empty rect";
        return false;
    }

    HDC screen = GetDC(nullptr);
    if (screen == nullptr) {
        err = "GetDC failed";
        return false;
    }
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    bool ok = false;
    if (dib != nullptr && bits != nullptr) {
        HGDIOBJ old = SelectObject(mem, dib);
        // CAPTUREBLT keeps layered windows in the result.
        if (BitBlt(mem, 0, 0, w, h, screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT)) {
            out.width = w;
            out.height = h;
            out.bgra.assign(static_cast<uint8_t*>(bits),
                            static_cast<uint8_t*>(bits) + static_cast<size_t>(w) * h * 4);
            for (size_t i = 3; i < out.bgra.size(); i += 4) out.bgra[i] = 0xFF;
            ok = true;
        } else {
            err = "BitBlt failed " + std::to_string(GetLastError());
        }
        SelectObject(mem, old);
    } else {
        err = "CreateDIBSection failed";
    }
    if (dib != nullptr) DeleteObject(dib);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return ok;
}

// ---------------------------------------------------------------- printwindow

static RECT WindowBounds(HWND hwnd) {
    RECT r = {};
    if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)))) {
        GetWindowRect(hwnd, &r);
    }
    return r;
}

static bool CapturePrintWindow(HWND hwnd, Frame& out, std::string& err) {
    if (hwnd == nullptr || !IsWindow(hwnd)) {
        err = "bad hwnd";
        return false;
    }
    RECT r = WindowBounds(hwnd);
    int w = r.right - r.left;
    int h = r.bottom - r.top;
    if (w <= 0 || h <= 0) {
        err = "window has no area";
        return false;
    }

    HDC screen = GetDC(nullptr);
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi = {};
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;

    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    bool ok = false;
    if (dib != nullptr && bits != nullptr) {
        HGDIOBJ old = SelectObject(mem, dib);
        // PW_RENDERFULLCONTENT asks for DWM-composed content (Win 8.1+).
        if (PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)) {
            out.width = w;
            out.height = h;
            out.bgra.assign(static_cast<uint8_t*>(bits),
                            static_cast<uint8_t*>(bits) + static_cast<size_t>(w) * h * 4);
            for (size_t i = 3; i < out.bgra.size(); i += 4) out.bgra[i] = 0xFF;
            ok = true;
        } else {
            err = "PrintWindow failed " + std::to_string(GetLastError());
        }
        SelectObject(mem, old);
    } else {
        err = "CreateDIBSection failed";
    }
    if (dib != nullptr) DeleteObject(dib);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return ok;
}

// ---------------------------------------------------------------- dxgi

static bool BlitOutput(ID3D11DeviceContext* ctx, ID3D11Texture2D* texture,
                       const RECT& outputRect, const RECT& want, Frame& out,
                       std::string& err) {
    D3D11_TEXTURE2D_DESC desc = {};
    texture->GetDesc(&desc);

    D3D11_TEXTURE2D_DESC staging = desc;
    staging.Usage = D3D11_USAGE_STAGING;
    staging.BindFlags = 0;
    staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging.MiscFlags = 0;

    ComPtr<ID3D11Texture2D> copy;
    ID3D11Device* dev = nullptr;
    ctx->GetDevice(&dev);
    if (dev == nullptr) {
        err = "no device";
        return false;
    }
    HRESULT hr = dev->CreateTexture2D(&staging, nullptr, &copy);
    dev->Release();
    if (FAILED(hr)) {
        err = "staging texture " + HrText(hr);
        return false;
    }
    ctx->CopyResource(copy.Get(), texture);
    D3D11_TEXTURE2D_DESC copyDesc = {};
    copy->GetDesc(&copyDesc);
    DBG("  copy desc %dx%d usage %d cpu %d bind %d misc %d\n", copyDesc.Width, copyDesc.Height,
        static_cast<int>(copyDesc.Usage), copyDesc.CPUAccessFlags, copyDesc.BindFlags,
        copyDesc.MiscFlags);

    D3D11_MAPPED_SUBRESOURCE map = {};
    hr = ctx->Map(copy.Get(), 0, D3D11_MAP_READ, 0, &map);
    if (FAILED(hr)) {
        err = "map staging " + HrText(hr);
        return false;
    }

    const int texW = static_cast<int>(desc.Width);
    const int texH = static_cast<int>(desc.Height);
    DBG("  first bytes: %02x %02x %02x %02x | %02x %02x %02x %02x\n",
        static_cast<uint8_t*>(map.pData)[0], static_cast<uint8_t*>(map.pData)[1],
        static_cast<uint8_t*>(map.pData)[2], static_cast<uint8_t*>(map.pData)[3],
        static_cast<uint8_t*>(map.pData)[4], static_cast<uint8_t*>(map.pData)[5],
        static_cast<uint8_t*>(map.pData)[6], static_cast<uint8_t*>(map.pData)[7]);
    const int outW = static_cast<int>(want.right - want.left);
    const int outH = static_cast<int>(want.bottom - want.top);
    DBG("blit tex %dx%d fmt %d pitch %u out %dx%d outRect %ld,%ld..%ld,%ld want %ld,%ld..%ld,%ld\n",
        texW, texH, static_cast<int>(desc.Format), map.RowPitch, outW, outH,
        outputRect.left, outputRect.top, outputRect.right, outputRect.bottom,
        want.left, want.top, want.right, want.bottom);

    // Intersection of the monitor and the requested rectangle, in desktop space.
    RECT inter = {};
    inter.left = std::max(outputRect.left, want.left);
    inter.top = std::max(outputRect.top, want.top);
    inter.right = std::min(outputRect.right, want.right);
    inter.bottom = std::min(outputRect.bottom, want.bottom);
    if (inter.right <= inter.left || inter.bottom <= inter.top) {
        ctx->Unmap(copy.Get(), 0);
        return true;  // nothing of this monitor is in the request
    }

    for (int y = inter.top; y < inter.bottom; ++y) {
        const int sy = y - outputRect.top;
        if (sy < 0 || sy >= texH) continue;
        const int sx = inter.left - outputRect.left;
        if (sx < 0 || sx >= texW) continue;
        const int count = std::min(static_cast<int>(inter.right - inter.left), texW - sx);
        const uint8_t* src = static_cast<const uint8_t*>(map.pData) + sy * map.RowPitch + sx * 4;
        uint8_t* dst = out.bgra.data() + (static_cast<size_t>(y - want.top) * outW + (inter.left - want.left)) * 4;
        std::memcpy(dst, src, static_cast<size_t>(count) * 4);
    }
    ctx->Unmap(copy.Get(), 0);
    return true;
}

static bool CaptureDxgi(const RECT& want, Frame& out, std::string& err) {
    const int outW = static_cast<int>(want.right - want.left);
    const int outH = static_cast<int>(want.bottom - want.top);
    if (outW <= 0 || outH <= 0) {
        err = "empty rect";
        return false;
    }

    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL got = D3D_FEATURE_LEVEL_11_0;
    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                                   static_cast<UINT>(sizeof(levels) / sizeof(levels[0])), D3D11_SDK_VERSION,
                                   &device, &got, &context);
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
                               D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
                               static_cast<UINT>(sizeof(levels) / sizeof(levels[0])), D3D11_SDK_VERSION,
                               &device, &got, &context);
    }
    if (FAILED(hr)) {
        err = "D3D11CreateDevice " + HrText(hr);
        return false;
    }

    ComPtr<IDXGIDevice> dxgiDevice;
    ComPtr<IDXGIAdapter> adapter;
    ComPtr<IDXGIFactory1> factory;
    hr = device.As(&dxgiDevice);
    if (FAILED(hr)) {
        err = "device->DXGI " + HrText(hr);
        return false;
    }
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr)) {
        err = "GetAdapter " + HrText(hr);
        return false;
    }
    hr = adapter->GetParent(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
        err = "GetParent factory " + HrText(hr);
        return false;
    }

    out.width = outW;
    out.height = outH;
    out.bgra.assign(static_cast<size_t>(outW) * outH * 4, 0);

    bool anyOutput = false;
    std::string firstError;
    for (UINT a = 0;; ++a) {
        ComPtr<IDXGIAdapter1> adapter1;
        if (factory->EnumAdapters1(a, &adapter1) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC ad = {};
        adapter1->GetDesc(&ad);
        DBG("adapter %u: %ls\n", a, ad.Description);
        for (UINT o = 0;; ++o) {
            ComPtr<IDXGIOutput> output;
            if (adapter1->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC od = {};
            if (FAILED(output->GetDesc(&od))) continue;
            DBG("output %u: %ls rect %ld,%ld..%ld,%ld attached %d\n", o, od.DeviceName,
                od.DesktopCoordinates.left, od.DesktopCoordinates.top,
                od.DesktopCoordinates.right, od.DesktopCoordinates.bottom,
                od.AttachedToDesktop ? 1 : 0);
            RECT inter = {};
            inter.left = std::max(od.DesktopCoordinates.left, want.left);
            inter.top = std::max(od.DesktopCoordinates.top, want.top);
            inter.right = std::min(od.DesktopCoordinates.right, want.right);
            inter.bottom = std::min(od.DesktopCoordinates.bottom, want.bottom);
            if (inter.right <= inter.left || inter.bottom <= inter.top) continue;

            ComPtr<IDXGIOutput1> output1;
            if (FAILED(output.As(&output1))) continue;
            ComPtr<IDXGIOutputDuplication> dup;
            hr = output1->DuplicateOutput(device.Get(), &dup);
            if (FAILED(hr)) {
                if (firstError.empty()) firstError = "DuplicateOutput " + HrText(hr);
                continue;
            }
            bool gotFrame = false;
            for (int attempt = 0; attempt < 20 && !gotFrame; ++attempt) {
                DXGI_OUTDUPL_FRAME_INFO info = {};
                ComPtr<IDXGIResource> resource;
                hr = dup->AcquireNextFrame(attempt == 0 ? 250 : 120, &info, &resource);
                DBG("  AcquireNextFrame attempt %d hr 0x%08lX lastPresent %lld accum %u\n", attempt,
                    static_cast<unsigned long>(hr), static_cast<long long>(info.LastPresentTime.QuadPart),
                    info.AccumulatedFrames);
                if (SUCCEEDED(hr) && info.LastPresentTime.QuadPart == 0) {
                    // Cursor-only / empty update: the texture has no desktop image
                    // yet. Release and ask again instead of shipping a black frame.
                    dup->ReleaseFrame();
                    Sleep(60);
                    continue;
                }
                if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue;
                if (FAILED(hr)) {
                    if (firstError.empty()) firstError = "AcquireNextFrame " + HrText(hr);
                    break;
                }
                ComPtr<ID3D11Texture2D> texture;
                if (SUCCEEDED(resource.As(&texture))) {
                    std::string blitError;
                    if (BlitOutput(context.Get(), texture.Get(), od.DesktopCoordinates, want, out, blitError)) {
                        gotFrame = true;
                        anyOutput = true;
                    } else if (firstError.empty()) {
                        firstError = blitError;
                    }
                }
                dup->ReleaseFrame();
            }
            dup.Reset();
        }
    }

    if (!anyOutput) {
        err = firstError.empty() ? "no capturable output" : firstError;
        return false;
    }
    for (size_t i = 3; i < out.bgra.size(); i += 4) out.bgra[i] = 0xFF;
    return true;
}

// ---------------------------------------------------------------- modes

static RECT ScreenRect() {
    POINT cursor = {};
    GetCursorPos(&cursor);
    HMONITOR monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi = {sizeof(MONITORINFO)};
    if (monitor != nullptr && GetMonitorInfoW(monitor, &mi)) return mi.rcMonitor;
    RECT r = {};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &r, 0);
    return r;
}

static RECT DesktopRect() {
    return RECT{GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN)};
}

struct Capture {
    bool ok = false;
    std::string backend;
    std::string error;
    Frame frame;
    Stats stats;
    RECT origin = {};  // desktop-space position of frame pixel (0,0)
};

static Capture RunOne(const std::string& backend, const RECT& rect, HWND hwnd) {
    Capture c;
    c.backend = backend;
    c.origin = rect;
    bool ok = false;
    if (backend == "gdi") {
        ok = CaptureGdi(rect, c.frame, c.error);
    } else if (backend == "dxgi") {
        ok = CaptureDxgi(rect, c.frame, c.error);
    } else if (backend == "printwindow") {
        ok = CapturePrintWindow(hwnd, c.frame, c.error);
    } else {
        c.error = "unknown backend";
    }
    c.ok = ok;
    if (ok) c.stats = Analyze(c.frame);
    return c;
}

// auto order: printwindow (window mode only, cheapest and usually honest) ->
// dxgi (composited desktop) -> gdi (last resort).
static Capture RunAuto(const std::string& mode, const RECT& rect, HWND hwnd) {
    std::vector<std::string> order;
    if (hwnd != nullptr) order.push_back("printwindow");
    if (mode != "window") order.push_back("dxgi");
    order.push_back("gdi");

    Capture best;
    std::string notes;
    for (const std::string& backend : order) {
        Capture c = RunOne(backend, rect, hwnd);
        if (!c.ok) {
            if (!notes.empty()) notes += "; ";
            notes += backend + ": " + c.error;
            continue;
        }
        if (c.stats.lit > 0.0005 || c.stats.mean > 0.5) {
            return c;  // real pixels, stop here
        }
        if (!best.ok) best = c;  // remember a black frame as a fallback
        if (!notes.empty()) notes += "; ";
        notes += backend + ": all-black";
    }
    if (!best.ok) {
        best.ok = false;
        best.backend = "auto";
        best.error = notes.empty() ? "no backend produced a frame" : notes;
    }
    return best;
}

// ---------------------------------------------------------------- self test

static COLORREF g_paintSeed = 0;

static LRESULT CALLBACK TestWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
        case WM_PAINT: {
            PAINTSTRUCT ps = {};
            HDC dc = BeginPaint(hwnd, &ps);
            RECT r = {};
            GetClientRect(hwnd, &r);
            // Diagonal gradient so a placeholder cannot pass as content.
            for (int y = 0; y < r.bottom; y += 8) {
                for (int x = 0; x < r.right; x += 8) {
                    int v = (x * 255) / std::max(1L, r.right);
                    HBRUSH brush = CreateSolidBrush(RGB(v, 160, (y * 255) / std::max(1L, r.bottom)));
                    RECT cell = {x, y, std::min<LONG>(x + 8, r.right), std::min<LONG>(y + 8, r.bottom)};
                    FillRect(dc, &cell, brush);
                    DeleteObject(brush);
                }
            }
            SetTextColor(dc, RGB(255, 255, 255));
            SetBkMode(dc, TRANSPARENT);
            DrawTextW(dc, L"DSH shotcap WDA lab", -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static void PumpFor(int millis) {
    DWORD end = GetTickCount() + millis;
    MSG msg;
    while (GetTickCount() < end) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Sleep(10);
    }
}

static std::string SelfTestWda(const std::string& wdaMode) {
    DWORD affinity = WDA_NONE;
    if (wdaMode == "monitor") affinity = WDA_MONITOR;
    else if (wdaMode == "exclude") affinity = WDA_EXCLUDEFROMCAPTURE;

    WNDCLASSEXW wc = {sizeof(wc)};
    wc.lpfnWndProc = TestWndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = L"DSHShotcapWdaLab";
    RegisterClassExW(&wc);

    const int w = 520, h = 340;
    HMONITOR monitor = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi = {sizeof(mi)};
    GetMonitorInfoW(monitor, &mi);
    int left = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - w) / 2;
    int top = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - h) / 2;

    HWND hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, wc.lpszClassName,
                                L"shotcap WDA lab", WS_POPUP | WS_VISIBLE, left, top, w, h,
                                nullptr, nullptr, wc.hInstance, nullptr);
    if (hwnd == nullptr) return "{\"kind\":\"selftest\",\"ok\":false,\"error\":\"CreateWindow failed\"}";

    SetWindowDisplayAffinity(hwnd, affinity);
    SetForegroundWindow(hwnd);
    PumpFor(700);

    RECT bounds = WindowBounds(hwnd);
    Frame gdi, dxgi, print;
    std::string e1, e2, e3;
    bool okGdi = CaptureGdi(bounds, gdi, e1);
    bool okDxgi = CaptureDxgi(bounds, dxgi, e2);
    bool okPrint = CapturePrintWindow(hwnd, print, e3);
    Stats s1 = okGdi ? Analyze(gdi) : Stats{};
    Stats s2 = okDxgi ? Analyze(dxgi) : Stats{};
    Stats s3 = okPrint ? Analyze(print) : Stats{};

    DestroyWindow(hwnd);
    PumpFor(50);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);

    char buf[2048];
    std::snprintf(buf, sizeof(buf),
                  "{\"kind\":\"selftest\",\"wda\":\"%s\",\"affinity\":%lu,"
                  "\"gdi\":{\"ok\":%s,\"lit\":%.4f,\"mean\":%.2f,\"error\":\"%s\"},"
                  "\"dxgi\":{\"ok\":%s,\"lit\":%.4f,\"mean\":%.2f,\"error\":\"%s\"},"
                  "\"printwindow\":{\"ok\":%s,\"lit\":%.4f,\"mean\":%.2f,\"error\":\"%s\"}}",
                  wdaMode.c_str(), static_cast<unsigned long>(affinity),
                  okGdi ? "true" : "false", s1.lit, s1.mean, JsonEscape(e1).c_str(),
                  okDxgi ? "true" : "false", s2.lit, s2.mean, JsonEscape(e2).c_str(),
                  okPrint ? "true" : "false", s3.lit, s3.mean, JsonEscape(e3).c_str());
    return std::string(buf);
}

// ---------------------------------------------------------------- hold mode

// Create one protected window in *this* process and keep it alive so another
// process (wdaclear.exe) can be pointed at it. Used by the capture lab tests.
static int RunHold(int seconds, const std::string& wdaMode) {
    DWORD affinity = WDA_NONE;
    if (wdaMode == "monitor") affinity = WDA_MONITOR;
    else if (wdaMode == "exclude") affinity = WDA_EXCLUDEFROMCAPTURE;

    WNDCLASSEXW wc = {sizeof(wc)};
    wc.lpfnWndProc = TestWndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = L"DSHShotcapWdaHold";
    RegisterClassExW(&wc);

    const int w = 520, h = 340;
    HMONITOR monitor = MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi = {sizeof(mi)};
    GetMonitorInfoW(monitor, &mi);
    int left = mi.rcWork.left + (mi.rcWork.right - mi.rcWork.left - w) / 2;
    int top = mi.rcWork.top + (mi.rcWork.bottom - mi.rcWork.top - h) / 2;
    HWND hwnd = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, wc.lpszClassName,
                                L"shotcap WDA hold", WS_POPUP | WS_VISIBLE, left, top, w, h,
                                nullptr, nullptr, wc.hInstance, nullptr);
    if (hwnd == nullptr) return 3;
    SetWindowDisplayAffinity(hwnd, affinity);
    SetForegroundWindow(hwnd);
    RECT bounds = WindowBounds(hwnd);
    std::printf("{\"kind\":\"hold\",\"hwnd\":\"0x%llX\",\"pid\":%lu,\"rect\":[%ld,%ld,%ld,%ld],"
                "\"wda\":\"%s\"}\n",
                static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hwnd)),
                static_cast<unsigned long>(GetCurrentProcessId()), bounds.left, bounds.top,
                bounds.right - bounds.left, bounds.bottom - bounds.top, wdaMode.c_str());
    std::fflush(stdout);

    DWORD end = GetTickCount() + static_cast<DWORD>(std::max(1, seconds)) * 1000;
    while (GetTickCount() < end) PumpFor(50);
    DestroyWindow(hwnd);
    UnregisterClassW(wc.lpszClassName, wc.hInstance);
    return 0;
}

// ---------------------------------------------------------------- crop stats

static bool CropStats(const Capture& capture, RECT crop, Stats& stats) {
    if (!capture.ok || capture.frame.bgra.empty()) return false;
    RECT frameRect = {capture.origin.left, capture.origin.top,
                      capture.origin.left + capture.frame.width,
                      capture.origin.top + capture.frame.height};
    RECT inter = {std::max(frameRect.left, crop.left), std::max(frameRect.top, crop.top),
                  std::min(frameRect.right, crop.right), std::min(frameRect.bottom, crop.bottom)};
    if (inter.right <= inter.left || inter.bottom <= inter.top) return false;
    Frame sub;
    sub.width = inter.right - inter.left;
    sub.height = inter.bottom - inter.top;
    sub.bgra.reserve(static_cast<size_t>(sub.width) * sub.height * 4);
    for (int y = inter.top; y < inter.bottom; ++y) {
        const size_t offset = (static_cast<size_t>(y - frameRect.top) * capture.frame.width
                               + (inter.left - frameRect.left)) * 4;
        sub.bgra.insert(sub.bgra.end(), capture.frame.bgra.begin() + offset,
                        capture.frame.bgra.begin() + offset + static_cast<size_t>(sub.width) * 4);
    }
    stats = Analyze(sub);
    return true;
}

// ---------------------------------------------------------------- main

#ifndef SHOTCAP_NO_MAIN
int wmain(int argc, wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (GetEnvironmentVariableW(L"DSH_SHOTCAP_DEBUG", nullptr, 0) > 0) g_debug = true;

    std::wstring out;
    std::string mode = "screen";
    std::string backend = "auto";
    std::string wda = "exclude";
    HWND hwnd = nullptr;
    bool selftest = false;
    bool json = false;
    int holdSeconds = 0;
    RECT crop = {0, 0, 0, 0};
    bool hasCrop = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = Utf8(argv[i]);
        auto next = [&](std::string& dst) {
            if (i + 1 < argc) dst = Utf8(argv[++i]);
        };
        if (arg == "--out") {
            if (i + 1 < argc) out = argv[++i];
        } else if (arg == "--mode") {
            next(mode);
        } else if (arg == "--backend") {
            next(backend);
        } else if (arg == "--wda") {
            next(wda);
        } else if (arg == "--hold") {
            holdSeconds = 20;
            if (i + 1 < argc) {
                std::string maybe = Utf8(argv[i + 1]);
                if (!maybe.empty() && maybe[0] != '-') {
                    holdSeconds = std::atoi(maybe.c_str());
                    ++i;
                }
            }
        } else if (arg == "--crop") {
            std::string spec;
            next(spec);
            long a = 0, b = 0, c = 0, d = 0;
            if (std::sscanf(spec.c_str(), "%ld,%ld,%ld,%ld", &a, &b, &c, &d) == 4) {
                crop = {a, b, a + c, b + d};
                hasCrop = true;
            }
        } else if (arg == "--hwnd") {
            std::string hex;
            next(hex);
            hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(hex, nullptr, 16)));
        } else if (arg == "--selftest-wda") {
            selftest = true;
        } else if (arg == "--json") {
            json = true;
        } else if (arg == "--help" || arg == "-h") {
            std::printf("shotcap --out PATH [--mode screen|desktop|window] "
                        "[--backend auto|gdi|dxgi|printwindow] [--hwnd 0xHEX] [--json]\n"
                        "        --selftest-wda [--wda none|monitor|exclude]\n");
            CoUninitialize();
            return 0;
        }
    }

    if (selftest) {
        std::string line = SelfTestWda(wda);
        std::printf("%s\n", line.c_str());
        CoUninitialize();
        return 0;
    }

    if (holdSeconds > 0) {
        int code = RunHold(holdSeconds, wda);
        CoUninitialize();
        return code;
    }

    if (out.empty()) {
        std::printf("{\"kind\":\"error\",\"message\":\"missing --out\"}\n");
        CoUninitialize();
        return 2;
    }

    RECT rect = mode == "desktop" ? DesktopRect() : mode == "window" ? WindowBounds(hwnd) : ScreenRect();
    Capture capture = backend == "auto" ? RunAuto(mode, rect, hwnd) : RunOne(backend, rect, hwnd);
    if (capture.ok && mode == "window" && hwnd != nullptr) {
        // In window mode the frame is the window rect already.
    }

    std::string saveError;
    bool saved = false;
    if (capture.ok) saved = SavePng(capture.frame, out, saveError);

    std::string cropJson = "null";
    if (hasCrop && capture.ok) {
        Stats cs;
        if (CropStats(capture, crop, cs)) {
            char buf[160];
            std::snprintf(buf, sizeof(buf), "{\"lit\":%.4f,\"mean\":%.2f}", cs.lit, cs.mean);
            cropJson = buf;
        }
    }

    std::string path = Utf8(out);
    char head[640];
    std::snprintf(head, sizeof(head),
                  "{\"kind\":\"capture\",\"backend\":\"%s\",\"path\":\"%s\","
                  "\"width\":%d,\"height\":%d,\"blank\":%s,\"lit\":%.4f,\"mean\":%.2f,"
                  "\"crop\":%s,\"error\":",
                  JsonEscape(capture.backend).c_str(), JsonEscape(path).c_str(),
                  capture.frame.width, capture.frame.height,
                  (capture.ok && capture.stats.lit <= 0.0005) ? "true" : "false",
                  capture.stats.lit, capture.stats.mean, cropJson.c_str());
    if (!capture.ok) {
        std::printf("%s\"%s\"}\n", head, JsonEscape(capture.error).c_str());
        CoUninitialize();
        return 1;
    }
    if (!saved) {
        std::printf("%s\"%s\"}\n", head, JsonEscape(saveError).c_str());
        CoUninitialize();
        return 1;
    }
    std::printf("%snull}\n", head);

    if (!json) {
        char human[512];
        std::snprintf(human, sizeof(human),
                      "captured %dx%d via %s (lit %.1f%%, mean %.1f) -> %s\n",
                      capture.frame.width, capture.frame.height, capture.backend.c_str(),
                      capture.stats.lit * 100.0, capture.stats.mean, path.c_str());
        std::fputs(human, stderr);
    }
    CoUninitialize();
    return 0;
}
#endif // SHOTCAP_NO_MAIN

