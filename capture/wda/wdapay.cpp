// wdapay.dll — in-process payload that clears SetWindowDisplayAffinity.
//
// Loaded into the process that owns a capture-protected window. It sweeps every
// top-level window of that process, drops any WDA_MONITOR /
// WDA_EXCLUDEFROMCAPTURE back to WDA_NONE, and keeps sweeping for a while
// because most clients re-apply the flag whenever they repaint, switch tab, or
// regain focus. Once the window object says WDA_NONE, the DWM stops blanking
// the window in the capture path and any normal capture backend (gdi / dxgi)
// sees the real pixels again.
//
// The sweep writes %TEMP%\dsh-wda-<pid>.json so the injector can verify what
// happened inside the target process.

#include <windows.h>
#include <cstdio>

#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

namespace {

struct Hit {
    HWND hwnd;
    DWORD before;
    DWORD after;
    WCHAR cls[96];
};

constexpr int kMaxHits = 64;
Hit g_hits[kMaxHits];
volatile LONG g_hitCount = 0;
volatile LONG g_scanCount = 0;
volatile LONG g_stop = 0;

BOOL CALLBACK Collect(HWND hwnd, LPARAM param) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    DWORD affinity = 0;
    if (!GetWindowDisplayAffinity(hwnd, &affinity)) return TRUE;
    if (affinity == WDA_NONE) return TRUE;
    LONG index = InterlockedIncrement(&g_hitCount) - 1;
    if (index >= kMaxHits) {
        InterlockedDecrement(&g_hitCount);
        return TRUE;
    }
    SetWindowDisplayAffinity(hwnd, WDA_NONE);
    DWORD after = 0;
    GetWindowDisplayAffinity(hwnd, &after);
    g_hits[index].hwnd = hwnd;
    g_hits[index].before = affinity;
    g_hits[index].after = after;
    GetClassNameW(hwnd, g_hits[index].cls, 96);
    return TRUE;
}

void WriteReport() {
    WCHAR temp[MAX_PATH] = {};
    DWORD len = GetTempPathW(MAX_PATH, temp);
    if (len == 0 || len + 40 >= MAX_PATH) return;
    WCHAR path[MAX_PATH];
    wsprintfW(path, L"%sdsh-wda-%lu.json", temp, GetCurrentProcessId());

    HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;

    char buffer[8192];
    int used = 0;
    used += std::snprintf(buffer + used, sizeof(buffer) - used,
                          "{\"pid\":%lu,\"scans\":%ld,\"hits\":[", GetCurrentProcessId(),
                          static_cast<long>(g_scanCount));
    LONG count = g_hitCount;
    for (LONG i = 0; i < count && i < kMaxHits && used < 7000; ++i) {
        used += std::snprintf(buffer + used, sizeof(buffer) - used,
                              "%s{\"hwnd\":\"0x%llX\",\"before\":%lu,\"after\":%lu,\"class\":\"",
                              i == 0 ? "" : ",", static_cast<unsigned long long>(
                                  reinterpret_cast<uintptr_t>(g_hits[i].hwnd)),
                              static_cast<unsigned long>(g_hits[i].before),
                              static_cast<unsigned long>(g_hits[i].after));
        for (const WCHAR* p = g_hits[i].cls; *p != 0 && used < 7800; ++p) {
            buffer[used++] = static_cast<char>(*p < 0x80 ? *p : '?');
        }
        buffer[used] = 0;
        used += std::snprintf(buffer + used, sizeof(buffer) - used, "\"}");
    }
    used += std::snprintf(buffer + used, sizeof(buffer) - used, "]}\n");
    DWORD wrote = 0;
    WriteFile(file, buffer, static_cast<DWORD>(used), &wrote, nullptr);
    CloseHandle(file);
}

DWORD WINAPI Worker(LPVOID) {
    // ~8 s of sweeps, 250 ms apart: enough to defeat a client that re-arms the
    // flag on focus/repaint without leaving a permanent thread behind.
    for (int i = 0; i < 32 && InterlockedCompareExchange(&g_stop, 0, 0) == 0; ++i) {
        InterlockedIncrement(&g_scanCount);
        EnumWindows(Collect, 0);
        WriteReport();
        if (i >= 8) {
            // Nothing left to clear for a while: stop early.
            const LONG count = g_hitCount;
            if (count > 0) {
                LONG still = 0;
                for (LONG h = 0; h < count && h < kMaxHits; ++h) {
                    DWORD now = 0;
                    if (GetWindowDisplayAffinity(g_hits[h].hwnd, &now) && now != WDA_NONE) ++still;
                }
                if (still == 0) break;
            } else if (i >= 12) {
                break;
            }
        }
        Sleep(250);
    }
    return 0;
}

}  // namespace

extern "C" __declspec(dllexport) void DshWdaClearNow() {
    InterlockedIncrement(&g_scanCount);
    EnumWindows(Collect, 0);
    WriteReport();
}

extern "C" __declspec(dllexport) int DshWdaHitCount() { return g_hitCount; }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        HANDLE thread = CreateThread(nullptr, 0, Worker, nullptr, 0, nullptr);
        if (thread != nullptr) CloseHandle(thread);
    } else if (reason == DLL_PROCESS_DETACH) {
        InterlockedExchange(&g_stop, 1);
    }
    return TRUE;
}