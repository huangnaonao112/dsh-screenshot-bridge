// wdaclear — clear SetWindowDisplayAffinity protection so the capture backends
// can see a window again.
//
// Windows enforces "do not capture this window" inside the DWM. Both the GDI
// path (GetDC/BitBlt) and the composited-surface path (IDXGIOutputDuplication)
// return a placeholder for such a window, and PrintWindow is blocked as well on
// current builds. The flag itself lives in the window object of the *owning*
// process, and only that process may change it. So this tool either calls
// SetWindowDisplayAffinity itself (own windows) or loads wdapay.dll into the
// owner process and lets it clear the flag from the inside.
//
//   wdaclear --list                 show windows that currently block capture
//   wdaclear --clear [--target all|foreground|pid:N]
//   wdaclear --watch 10             keep clearing for 10 s
//
// Output is one JSON line (--list / --clear) or one line per sweep (--watch).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif
#ifndef WDA_MONITOR
#define WDA_MONITOR 0x00000001
#endif
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

namespace {

struct Target {
    HWND hwnd = nullptr;
    DWORD pid = 0;
    DWORD affinity = 0;
    std::string exe;
    std::string cls;
    std::string title;
    std::string method;
    DWORD after = 0;
    std::string error;
};

std::string Utf8(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int need = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                                   nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(need), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), out.data(),
                        need, nullptr, nullptr);
    return out;
}

std::string Narrow(const wchar_t* wide, int max) {
    std::wstring text(wide, wcsnlen(wide, static_cast<size_t>(max)));
    for (auto& c : text) {
        if (c > 0x7F) c = L'?';
    }
    return Utf8(text);
}

std::string JsonEscape(const std::string& in) {
    std::string out;
    for (char c : in) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            out += ' ';
        } else {
            out += c;
        }
    }
    return out;
}

std::string ExeName(DWORD pid) {
    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (proc == nullptr) return std::string();
    WCHAR path[1024] = {};
    DWORD size = 1024;
    std::string name;
    if (QueryFullProcessImageNameW(proc, 0, path, &size)) {
        std::wstring full(path);
        size_t slash = full.find_last_of(L"\\/");
        std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
        name = Utf8(base);
    }
    CloseHandle(proc);
    return name;
}

bool IsOurBitness(DWORD pid, std::string& why) {
    HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (proc == nullptr) {
        why = "query-denied " + std::to_string(GetLastError());
        return false;
    }
    BOOL wow64 = FALSE;
    USHORT machine = 0;
    USHORT native = 0;
    if (IsWow64Process2(proc, &machine, &native)) {
        // machine == IMAGE_FILE_MACHINE_UNKNOWN means the target runs 32-bit on 64-bit? No:
        // IsWow64Process2 reports IMAGE_FILE_MACHINE_I386 for WOW64 targets.
        if (machine == IMAGE_FILE_MACHINE_I386) {
            why = "arch-x86";
            CloseHandle(proc);
            return false;
        }
    } else if (!IsWow64Process(proc, &wow64)) {
        why = "query-denied " + std::to_string(GetLastError());
        CloseHandle(proc);
        return false;
    }
    CloseHandle(proc);
    return true;
}

std::wstring PayloadPath() {
    WCHAR self[MAX_PATH] = {};
    DWORD len = GetModuleFileNameW(nullptr, self, MAX_PATH);
    std::wstring path(self, len);
    size_t slash = path.find_last_of(L"\\/");
    std::wstring dir = slash == std::wstring::npos ? L"." : path.substr(0, slash);

    // Every build stamps its payload (wdapay-<stamp>.dll) because a payload
    // injected into a live process stays mapped and cannot be overwritten.
    WIN32_FIND_DATAW entry = {};
    HANDLE find = FindFirstFileW((dir + L"\\wdapay*.dll").c_str(), &entry);
    if (find == INVALID_HANDLE_VALUE) return dir + L"\\wdapay.dll";
    std::wstring best = dir + L"\\" + entry.cFileName;
    ULARGE_INTEGER bestTime = {};
    bestTime.LowPart = entry.ftLastWriteTime.dwLowDateTime;
    bestTime.HighPart = entry.ftLastWriteTime.dwHighDateTime;
    while (FindNextFileW(find, &entry)) {
        ULARGE_INTEGER stamp = {};
        stamp.LowPart = entry.ftLastWriteTime.dwLowDateTime;
        stamp.HighPart = entry.ftLastWriteTime.dwHighDateTime;
        if (stamp.QuadPart > bestTime.QuadPart) {
            best = dir + L"\\" + entry.cFileName;
            bestTime = stamp;
        }
    }
    FindClose(find);
    return best;
}

std::wstring ReportPath(DWORD pid) {
    WCHAR temp[MAX_PATH] = {};
    DWORD len = GetTempPathW(MAX_PATH, temp);
    WCHAR path[MAX_PATH];
    wsprintfW(path, L"%sdsh-wda-%lu.json", temp, pid);
    (void)len;
    return path;
}

bool Inject(DWORD pid, std::string& why) {
    if (pid == 0 || pid == 4) {
        why = "system-process";
        return false;
    }
    if (!IsOurBitness(pid, why)) return false;

    const std::wstring dll = PayloadPath();
    if (GetFileAttributesW(dll.c_str()) == INVALID_FILE_ATTRIBUTES) {
        why = "payload-missing";
        return false;
    }

    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
                                  PROCESS_QUERY_INFORMATION,
                              FALSE, pid);
    if (proc == nullptr) {
        why = "open-denied " + std::to_string(GetLastError());
        return false;
    }

    const SIZE_T bytes = (dll.size() + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(proc, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (remote == nullptr) {
        why = "alloc-denied " + std::to_string(GetLastError());
        CloseHandle(proc);
        return false;
    }
    SIZE_T written = 0;
    if (!WriteProcessMemory(proc, remote, dll.c_str(), bytes, &written)) {
        why = "write-denied " + std::to_string(GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        return false;
    }

    HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC loadLibrary = GetProcAddress(kernel32, "LoadLibraryW");
    HANDLE thread = CreateRemoteThread(proc, nullptr, 0,
                                       reinterpret_cast<LPTHREAD_START_ROUTINE>(loadLibrary),
                                       remote, 0, nullptr);
    if (thread == nullptr) {
        why = "thread-denied " + std::to_string(GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        return false;
    }
    WaitForSingleObject(thread, 4000);
    DWORD loaded = 0;
    GetExitCodeThread(thread, &loaded);
    CloseHandle(thread);
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    CloseHandle(proc);

    if (loaded == 0) {
        why = "loadlibrary-failed";
        return false;
    }
    // Wait for the payload's first sweep to land.
    for (int i = 0; i < 20; ++i) {
        if (GetFileAttributesW(ReportPath(pid).c_str()) != INVALID_FILE_ATTRIBUTES) break;
        Sleep(50);
    }
    return true;
}

std::vector<Target> Scan(DWORD filterPid, bool foregroundOnly) {
    std::vector<Target> out;
    HWND foreground = GetForegroundWindow();

    struct Ctx {
        std::vector<Target>* out;
        DWORD filterPid;
        HWND foreground;
        bool foregroundOnly;
    } ctx{&out, filterPid, foreground, foregroundOnly};

    EnumWindows(
        [](HWND hwnd, LPARAM param) -> BOOL {
            auto* c = reinterpret_cast<Ctx*>(param);
            if (c->foregroundOnly && hwnd != c->foreground) return TRUE;
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            if (c->filterPid != 0 && pid != c->filterPid) return TRUE;
            DWORD affinity = 0;
            if (!GetWindowDisplayAffinity(hwnd, &affinity)) return TRUE;
            if (affinity == WDA_NONE) return TRUE;
            Target t;
            t.hwnd = hwnd;
            t.pid = pid;
            t.affinity = affinity;
            t.exe = ExeName(pid);
            WCHAR cls[128] = {};
            GetClassNameW(hwnd, cls, 128);
            t.cls = Narrow(cls, 128);
            WCHAR title[160] = {};
            GetWindowTextW(hwnd, title, 160);
            t.title = Narrow(title, 160);
            c->out->push_back(t);
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&ctx));
    return out;
}

void PrintList(const std::vector<Target>& targets) {
    std::printf("{\"kind\":\"wdaclear\",\"mode\":\"list\",\"count\":%zu,\"windows\":[",
                targets.size());
    for (size_t i = 0; i < targets.size(); ++i) {
        const Target& t = targets[i];
        std::printf("%s{\"hwnd\":\"0x%llX\",\"pid\":%lu,\"exe\":\"%s\",\"class\":\"%s\",\"title\":\"%s\",\"affinity\":%lu}",
                    i == 0 ? "" : ",", static_cast<unsigned long long>(
                        reinterpret_cast<uintptr_t>(t.hwnd)),
                    static_cast<unsigned long>(t.pid), JsonEscape(t.exe).c_str(),
                    JsonEscape(t.cls).c_str(), JsonEscape(t.title).c_str(),
                    static_cast<unsigned long>(t.affinity));
    }
    std::printf("]}\n");
}

int Clear(const std::string& target, bool verbose) {
    DWORD filterPid = 0;
    bool foregroundOnly = false;
    if (target == "foreground") foregroundOnly = true;
    else if (target.rfind("pid:", 0) == 0) filterPid = static_cast<DWORD>(std::stoul(target.substr(4)));

    std::vector<Target> targets = Scan(filterPid, foregroundOnly);
    if (targets.empty()) {
        std::printf("{\"kind\":\"wdaclear\",\"mode\":\"clear\",\"cleared\":0,\"windows\":[],\"failed\":[]}\n");
        return 0;
    }

    // Own windows can be changed in place; everything else needs the payload.
    std::vector<DWORD> pushed;
    for (Target& t : targets) {
        if (t.pid == GetCurrentProcessId()) {
            t.method = "in-process";
            SetWindowDisplayAffinity(t.hwnd, WDA_NONE);
        } else if (std::find(pushed.begin(), pushed.end(), t.pid) == pushed.end()) {
            std::string why;
            if (Inject(t.pid, why)) {
                t.method = "payload";
                pushed.push_back(t.pid);
            } else {
                t.method = "failed";
                t.error = why;
            }
        } else {
            t.method = "payload";
        }
    }

    // Give the payload a moment, then verify from out here.
    Sleep(400);
    for (Target& t : targets) {
        DWORD now = 0;
        if (GetWindowDisplayAffinity(t.hwnd, &now)) t.after = now;
    }

    size_t cleared = 0;
    for (const Target& t : targets) {
        if (t.after == WDA_NONE) ++cleared;
    }

    std::printf("{\"kind\":\"wdaclear\",\"mode\":\"clear\",\"cleared\":%zu,\"total\":%zu,\"windows\":[",
                cleared, targets.size());
    for (size_t i = 0; i < targets.size(); ++i) {
        const Target& t = targets[i];
        std::printf("%s{\"hwnd\":\"0x%llX\",\"pid\":%lu,\"exe\":\"%s\",\"class\":\"%s\",\"before\":%lu,\"after\":%lu,\"method\":\"%s\",\"error\":\"%s\"}",
                    i == 0 ? "" : ",", static_cast<unsigned long long>(
                        reinterpret_cast<uintptr_t>(t.hwnd)),
                    static_cast<unsigned long>(t.pid), JsonEscape(t.exe).c_str(),
                    JsonEscape(t.cls).c_str(), static_cast<unsigned long>(t.affinity),
                    static_cast<unsigned long>(t.after), t.method.c_str(),
                    JsonEscape(t.error).c_str());
    }
    std::printf("]}\n");

    if (verbose) {
        std::fprintf(stderr, "cleared %zu/%zu protected windows\n", cleared, targets.size());
    }
    return cleared == targets.size() ? 0 : 1;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    std::string mode = "clear";
    std::string target = "all";
    bool verbose = false;
    int watchSeconds = 0;

    for (int i = 1; i < argc; ++i) {
        std::string arg = Utf8(argv[i]);
        if (arg == "--list") {
            mode = "list";
        } else if (arg == "--clear") {
            mode = "clear";
        } else if (arg == "--target" && i + 1 < argc) {
            target = Utf8(argv[++i]);
        } else if (arg == "--watch" && i + 1 < argc) {
            watchSeconds = std::atoi(Utf8(argv[++i]).c_str());
        } else if (arg == "--verbose" || arg == "-v") {
            verbose = true;
        } else if (arg == "--help" || arg == "-h") {
            std::printf("wdaclear --list | --clear [--target all|foreground|pid:N] | --watch SECONDS\n");
            return 0;
        }
    }

    if (mode == "list") {
        PrintList(Scan(0, false));
        return 0;
    }
    if (watchSeconds > 0) {
        DWORD end = GetTickCount() + static_cast<DWORD>(watchSeconds) * 1000;
        int last = 0;
        while (GetTickCount() < end) {
            last = Clear(target, false);
            Sleep(500);
        }
        return last;
    }
    return Clear(target, verbose);
}