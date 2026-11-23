// dshcapctl — user-mode front end for dshshot.sys.
//
//   dshcapctl --status
//   dshcapctl --clear  [--hwnd 0x1234] [--pid N] [--guard SECONDS]
//
// Without a driver the tool reports driver-not-loaded and exits 1; the plugin
// then stays on wdaclear.exe (the user-mode payload path).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>

#include <cstdio>
#include <cstdlib>
#include <string>

#define DSHSHOT_DEVICE_TYPE 0x8330
#define IOCTL_DSHSHOT_CLEAR \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_DSHSHOT_GUARD \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_DSHSHOT_STATUS \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)

struct Request {
    unsigned long long hwnd;
    unsigned long pid;
    unsigned long long setAffinity;
    unsigned long long exitThread;
    unsigned long seconds;
    unsigned long intervalMs;
};

struct Status {
    unsigned long clearCalls;
    unsigned long clearOk;
    unsigned long clearFail;
    unsigned long guardActive;
    long lastStatus;
};

static HANDLE OpenDevice() {
    return CreateFileW(L"\\\\.\\DshShotCap", GENERIC_READ | GENERIC_WRITE,
                       FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                       FILE_ATTRIBUTE_NORMAL, nullptr);
}

int wmain(int argc, wchar_t** argv) {
    bool statusMode = false;
    bool clearMode = false;
    bool guard = false;
    unsigned long long hwnd = 0;
    unsigned long pid = 0;
    unsigned long seconds = 10;

    for (int i = 1; i < argc; ++i) {
        std::wstring arg = argv[i];
        if (arg == L"--status") {
            statusMode = true;
        } else if (arg == L"--clear") {
            clearMode = true;
        } else if (arg == L"--guard" && i + 1 < argc) {
            guard = true;
            seconds = static_cast<unsigned long>(std::wcstoul(argv[++i], nullptr, 10));
        } else if (arg == L"--hwnd" && i + 1 < argc) {
            hwnd = std::wcstoull(argv[++i], nullptr, 16);
        } else if (arg == L"--pid" && i + 1 < argc) {
            pid = static_cast<unsigned long>(std::wcstoul(argv[++i], nullptr, 10));
        } else if (arg == L"--help" || arg == L"-h") {
            std::printf("dshcapctl --status | --clear [--hwnd 0xHEX] [--pid N] [--guard SECONDS]\n");
            return 0;
        }
    }

    HANDLE device = OpenDevice();
    if (device == INVALID_HANDLE_VALUE) {
        DWORD error = GetLastError();
        std::printf("{\"kind\":\"dshcapctl\",\"ok\":false,\"error\":\"driver-not-loaded\",\"win32\":%lu}\n",
                    static_cast<unsigned long>(error));
        return 1;
    }

    if (statusMode) {
        Status snapshot = {};
        DWORD returned = 0;
        BOOL ok = DeviceIoControl(device, IOCTL_DSHSHOT_STATUS, nullptr, 0, &snapshot,
                                  sizeof(snapshot), &returned, nullptr);
        std::printf("{\"kind\":\"dshcapctl\",\"ok\":%s,\"clearCalls\":%lu,\"clearOk\":%lu,"
                    "\"clearFail\":%lu,\"guardActive\":%lu,\"lastStatus\":0x%08lX}\n",
                    ok ? "true" : "false", snapshot.clearCalls, snapshot.clearOk,
                    snapshot.clearFail, snapshot.guardActive,
                    static_cast<unsigned long>(snapshot.lastStatus));
        CloseHandle(device);
        return ok ? 0 : 1;
    }

    if (clearMode) {
        if (hwnd == 0) {
            // Default to the foreground window, matching the plugin's default.
            hwnd = reinterpret_cast<unsigned long long>(GetForegroundWindow());
        }
        if (pid == 0) {
            DWORD owner = 0;
            GetWindowThreadProcessId(reinterpret_cast<HWND>(static_cast<uintptr_t>(hwnd)), &owner);
            pid = owner;
        }
        FARPROC setAffinity = GetProcAddress(GetModuleHandleW(L"user32.dll"),
                                             "SetWindowDisplayAffinity");
        FARPROC exitThread = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "ExitThread");
        Request request = {};
        request.hwnd = hwnd;
        request.pid = pid;
        request.setAffinity = reinterpret_cast<unsigned long long>(setAffinity);
        request.exitThread = reinterpret_cast<unsigned long long>(exitThread);
        request.seconds = seconds;
        request.intervalMs = 250;

        DWORD returned = 0;
        BOOL ok = DeviceIoControl(device, guard ? IOCTL_DSHSHOT_GUARD : IOCTL_DSHSHOT_CLEAR,
                                  &request, sizeof(request), &request, sizeof(request), &returned,
                                  nullptr);
        DWORD error = ok ? 0 : GetLastError();
        std::printf("{\"kind\":\"dshcapctl\",\"ok\":%s,\"mode\":\"%s\",\"hwnd\":\"0x%llX\","
                    "\"pid\":%lu,\"win32\":%lu}\n",
                    ok ? "true" : "false", guard ? "guard" : "clear", hwnd,
                    static_cast<unsigned long>(pid), static_cast<unsigned long>(error));
        CloseHandle(device);
        return ok ? 0 : 1;
    }

    CloseHandle(device);
    std::printf("{\"kind\":\"dshcapctl\",\"ok\":false,\"error\":\"no-mode\"}\n");
    return 2;
}