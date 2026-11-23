// dshshot.sys — kernel half of the screenshot bridge's capture-protection bypass.
//
// Why this has to be kernel work: Windows enforces "this window must not appear
// in any capture" inside the compositor. The flag is stored in the window object
// and may only be changed by the process that owns the window. A normal user
// process cannot open a guarded process (anti-cheat, protected processes, a
// service running as another user) and cannot create a thread in it either.
//
// This driver runs as SYSTEM, opens the owning process with kernel handles, and
// creates the one thread that is allowed to call
// SetWindowDisplayAffinity(hwnd, WDA_NONE) from the inside. It does not patch
// win32k, does not need build-specific offsets, and leaves no image on disk in
// the target. Once the flag is cleared the compositor stops hiding the window,
// and the ordinary capture backends (shotcap.exe) see real pixels again.
//
// Device:  \Device\DshShotCap  (symlink \DosDevices\DshShotCap)
// Control:
//   IOCTL_DSHSHOT_CLEAR  {hwnd, pid, fnSetWindowDisplayAffinity} -> clears once
//   IOCTL_DSHSHOT_GUARD  {hwnd, pid, fn, seconds, intervalMs}    -> keeps clearing
//   IOCTL_DSHSHOT_STATUS                                          -> counters
//
// The function address comes from the caller because user32.dll is a KnownDLL
// and therefore sits at the same base in every 64-bit process; the caller has
// already resolved SetWindowDisplayAffinity for its own process.

#define NTDDI_VERSION 0x0A00000C
#define _WIN32_WINNT 0x0A00
#include <ntifs.h>

typedef NTSTATUS(NTAPI* PFN_ZWCREATETHREADEX)(
    PHANDLE ThreadHandle, ACCESS_MASK DesiredAccess, POBJECT_ATTRIBUTES ObjectAttributes,
    HANDLE ProcessHandle, PVOID StartRoutine, PVOID Argument, ULONG CreateFlags,
    SIZE_T ZeroBits, SIZE_T StackSize, SIZE_T MaximumStackSize, PVOID AttributeList);
typedef NTSTATUS(NTAPI* PFN_ZWTERMINATETHREAD)(HANDLE ThreadHandle, NTSTATUS ExitStatus);

static PFN_ZWCREATETHREADEX g_ZwCreateThreadEx = NULL;
static PFN_ZWTERMINATETHREAD g_ZwTerminateThread = NULL;

static PVOID ResolveRoutine(const WCHAR* name) {
    UNICODE_STRING routine;
    RtlInitUnicodeString(&routine, name);
    return MmGetSystemRoutineAddress(&routine);
}

NTSYSAPI NTSTATUS NTAPI ZwAllocateVirtualMemory(HANDLE ProcessHandle, PVOID* BaseAddress,
                                                ULONG_PTR ZeroBits, PSIZE_T RegionSize,
                                                ULONG AllocationType, ULONG Protect);
NTSYSAPI NTSTATUS NTAPI ZwFreeVirtualMemory(HANDLE ProcessHandle, PVOID* BaseAddress,
                                            PSIZE_T RegionSize, ULONG FreeType);
NTSYSAPI NTSTATUS NTAPI ZwOpenProcess(PHANDLE ProcessHandle, ACCESS_MASK DesiredAccess,
                                      POBJECT_ATTRIBUTES ObjectAttributes, PCLIENT_ID ClientId);
NTSYSAPI NTSTATUS NTAPI ZwWaitForSingleObject(HANDLE Handle, BOOLEAN Alertable,
                                              PLARGE_INTEGER Timeout);
NTSYSAPI NTSTATUS NTAPI ZwClose(HANDLE Handle);
NTSYSAPI PVOID NTAPI PsGetProcessWow64Process(PEPROCESS Process);

NTSYSAPI PVOID NTAPI PsGetProcessWow64Process(PEPROCESS Process);

#define DSHSHOT_DEVICE_NAME L"\\Device\\DshShotCap"
#define DSHSHOT_SYMLINK_NAME L"\\DosDevices\\DshShotCap"

#define DSHSHOT_DEVICE_TYPE 0x8330

#define IOCTL_DSHSHOT_CLEAR \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_DSHSHOT_GUARD \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define IOCTL_DSHSHOT_STATUS \
    CTL_CODE(DSHSHOT_DEVICE_TYPE, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS)

typedef struct _DSHSHOT_REQUEST {
    ULONG64 Hwnd;
    ULONG Pid;
    ULONG64 SetAffinity;
    ULONG64 ExitThread;
    ULONG Seconds;
    ULONG IntervalMs;
} DSHSHOT_REQUEST, *PDSHSHOT_REQUEST;

typedef struct _DSHSHOT_STATUS {
    ULONG ClearCalls;
    ULONG ClearOk;
    ULONG ClearFail;
    ULONG GuardActive;
    NTSTATUS LastStatus;
} DSHSHOT_STATUS, *PDSHSHOT_STATUS;

typedef struct _GUARD_CONTEXT {
    ULONG64 Hwnd;
    ULONG Pid;
    ULONG64 SetAffinity;
    ULONG64 ExitThread;
    ULONG Seconds;
    ULONG IntervalMs;
    volatile LONG Stop;
} GUARD_CONTEXT, *PGUARD_CONTEXT;

static PDEVICE_OBJECT g_device = NULL;
static DSHSHOT_STATUS g_status;
static PGUARD_CONTEXT g_guardContext = NULL;

typedef NTSTATUS(NTAPI* PFN_ZWCREATETHREADEX)(
    PHANDLE ThreadHandle, ACCESS_MASK DesiredAccess, POBJECT_ATTRIBUTES ObjectAttributes,
    HANDLE ProcessHandle, PVOID StartRoutine, PVOID Argument, ULONG CreateFlags,
    SIZE_T ZeroBits, SIZE_T StackSize, SIZE_T MaximumStackSize, PVOID AttributeList);

/// x64 stub, executed inside the target process:
///   sub rsp,28h
///   mov rcx, <hwnd>
///   xor edx,edx                       ; WDA_NONE
///   mov rax, <SetWindowDisplayAffinity>
///   call rax
///   xor ecx,ecx                       ; ExitThread(0) so the thread leaves cleanly
///   mov rax, <ExitThread>
///   call rax
static const UCHAR kStubPrefix[] = {0x48, 0x83, 0xEC, 0x28, 0x48, 0xB9};
static const UCHAR kStubZeroDx[] = {0x31, 0xD2, 0x48, 0xB8};
static const UCHAR kStubCall[] = {0xFF, 0xD0, 0x31, 0xC9, 0x48, 0xB8};
static const UCHAR kStubTail[] = {0xFF, 0xD0, 0x48, 0x83, 0xC4, 0x28, 0xC3};

#define STUB_SIZE 64

static void BuildStub(UCHAR stub[STUB_SIZE], ULONG64 hwnd, ULONG64 fnSet, ULONG64 fnExit) {
    RtlZeroMemory(stub, STUB_SIZE);
    ULONG at = 0;
    RtlCopyMemory(stub + at, kStubPrefix, sizeof(kStubPrefix));
    at += sizeof(kStubPrefix);
    RtlCopyMemory(stub + at, &hwnd, sizeof(hwnd));
    at += sizeof(hwnd);
    RtlCopyMemory(stub + at, kStubZeroDx, sizeof(kStubZeroDx));
    at += sizeof(kStubZeroDx);
    RtlCopyMemory(stub + at, &fnSet, sizeof(fnSet));
    at += sizeof(fnSet);
    RtlCopyMemory(stub + at, kStubCall, sizeof(kStubCall));
    at += sizeof(kStubCall);
    RtlCopyMemory(stub + at, &fnExit, sizeof(fnExit));
    at += sizeof(fnExit);
    RtlCopyMemory(stub + at, kStubTail, sizeof(kStubTail));
}

/// One kernel-assisted call to SetWindowDisplayAffinity(hwnd, WDA_NONE) inside
/// the owning process.
static NTSTATUS ClearInProcess(ULONG pid, ULONG64 hwnd, ULONG64 fnAddress, ULONG64 fnExit) {
    if (pid == 0 || pid == 4 || fnAddress == 0) return STATUS_INVALID_PARAMETER;

    PEPROCESS process = NULL;
    NTSTATUS status = PsLookupProcessByProcessId((HANDLE)(ULONG_PTR)pid, &process);
    if (!NT_SUCCESS(status)) return status;

    if (PsGetProcessWow64Process(process) != NULL) {
        // 32-bit target: the user32 base is different, so the supplied function
        // address is meaningless there.
        ObDereferenceObject(process);
        return STATUS_NOT_SUPPORTED;
    }

    CLIENT_ID clientId = {(HANDLE)(ULONG_PTR)pid, NULL};
    OBJECT_ATTRIBUTES attributes;
    InitializeObjectAttributes(&attributes, NULL, OBJ_KERNEL_HANDLE, NULL, NULL);

    HANDLE processHandle = NULL;
    status = ZwOpenProcess(&processHandle, PROCESS_ALL_ACCESS, &attributes, &clientId);
    if (!NT_SUCCESS(status)) {
        ObDereferenceObject(process);
        return status;
    }

    PVOID remote = NULL;
    SIZE_T regionSize = STUB_SIZE;
    status = ZwAllocateVirtualMemory(processHandle, &remote, 0, &regionSize,
                                     MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!NT_SUCCESS(status)) {
        ZwClose(processHandle);
        ObDereferenceObject(process);
        return status;
    }

    UCHAR stub[STUB_SIZE];
    BuildStub(stub, hwnd, fnAddress, fnExit);

    KAPC_STATE apc;
    KeStackAttachProcess(process, &apc);
    __try {
        ProbeForWrite(remote, STUB_SIZE, sizeof(UCHAR));
        RtlCopyMemory(remote, stub, STUB_SIZE);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        status = GetExceptionCode();
    }
    KeUnstackDetachProcess(&apc);
    if (!NT_SUCCESS(status)) {
        ZwFreeVirtualMemory(processHandle, &remote, &regionSize, MEM_RELEASE);
        ZwClose(processHandle);
        ObDereferenceObject(process);
        return status;
    }

    HANDLE thread = NULL;
    status = g_ZwCreateThreadEx(&thread, THREAD_ALL_ACCESS, NULL, processHandle, remote, NULL,
                                0x00020000 /* THREAD_CREATE_FLAGS_HIDE_FROM_DEBUGGER */, 0, 0, 0,
                                NULL);
    if (NT_SUCCESS(status)) {
        LARGE_INTEGER timeout;
        // The stub exits its own thread; 1 s is generous for one API call.
        timeout.QuadPart = -10000000LL;
        NTSTATUS waited = ZwWaitForSingleObject(thread, FALSE, &timeout);
        if (waited == STATUS_TIMEOUT) {
            g_ZwTerminateThread(thread, STATUS_SUCCESS);
        }
        ZwClose(thread);
    }

    // Only release the stub once the thread can no longer be running.
    if (NT_SUCCESS(status)) {
        regionSize = 0;
        ZwFreeVirtualMemory(processHandle, &remote, &regionSize, MEM_RELEASE);
    }
    ZwClose(processHandle);
    ObDereferenceObject(process);
    return status;
}

static VOID GuardThread(PVOID context) {
    PGUARD_CONTEXT guard = (PGUARD_CONTEXT)context;
    ULONG interval = guard->IntervalMs < 50 ? 50 : guard->IntervalMs;
    ULONG rounds = (guard->Seconds * 1000) / interval;
    LARGE_INTEGER delay;
    delay.QuadPart = -((LONGLONG)interval * 10000);
    for (ULONG i = 0; i < rounds; ++i) {
        if (InterlockedCompareExchange(&guard->Stop, 1, 0) == 1) break;
        NTSTATUS status = ClearInProcess(guard->Pid, guard->Hwnd, guard->SetAffinity,
                                         guard->ExitThread);
        g_status.LastStatus = status;
        if (NT_SUCCESS(status)) {
            InterlockedIncrement((volatile LONG*)&g_status.ClearOk);
        }
        KeDelayExecutionThread(KernelMode, FALSE, &delay);
    }
    InterlockedExchange((volatile LONG*)&g_status.GuardActive, 0);
    InterlockedCompareExchangePointer((PVOID*)&g_guardContext, NULL, guard);
    ExFreePoolWithTag(guard, 'gshD');
}

/* ---------------------------------------------------------------- IOCTLs */

static NTSTATUS HandleClear(PDSHSHOT_REQUEST request) {
    InterlockedIncrement((volatile LONG*)&g_status.ClearCalls);
    NTSTATUS status = ClearInProcess(request->Pid, request->Hwnd, request->SetAffinity,
                                     request->ExitThread);
    g_status.LastStatus = status;
    if (NT_SUCCESS(status)) {
        InterlockedIncrement((volatile LONG*)&g_status.ClearOk);
    } else {
        InterlockedIncrement((volatile LONG*)&g_status.ClearFail);
    }
    return status;
}

static NTSTATUS HandleGuard(PDSHSHOT_REQUEST request) {
    if (InterlockedCompareExchange((volatile LONG*)&g_status.GuardActive, 1, 0) == 1) {
        return STATUS_ALREADY_REGISTERED;
    }
    // One CLEAR per interval, driven by a system thread, so a client that
    // re-arms its protection on every repaint never gets a foothold.
    PGUARD_CONTEXT guard = (PGUARD_CONTEXT)ExAllocatePoolWithTag(NonPagedPool, sizeof(GUARD_CONTEXT), 'gshD');
    if (guard == NULL) {
        InterlockedExchange((volatile LONG*)&g_status.GuardActive, 0);
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlZeroMemory(guard, sizeof(*guard));
    guard->Hwnd = request->Hwnd;
    guard->Pid = request->Pid;
    guard->SetAffinity = request->SetAffinity;
    guard->ExitThread = request->ExitThread;
    guard->Seconds = request->Seconds == 0 ? 10 : request->Seconds;
    guard->IntervalMs = request->IntervalMs;
    InterlockedExchangePointer((PVOID*)&g_guardContext, guard);

    HANDLE thread = NULL;
    NTSTATUS status = PsCreateSystemThread(&thread, THREAD_ALL_ACCESS, NULL, NULL, NULL,
                                           (PKSTART_ROUTINE)GuardThread, guard);
    if (NT_SUCCESS(status)) {
        ZwClose(thread);
    } else {
        InterlockedExchange((volatile LONG*)&g_status.GuardActive, 0);
        ExFreePoolWithTag(guard, 'gshD');
    }
    return status;
}

static NTSTATUS DeviceControl(PDEVICE_OBJECT device, PIRP irp) {
    UNREFERENCED_PARAMETER(device);
    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(irp);
    ULONG code = stack->Parameters.DeviceIoControl.IoControlCode;
    ULONG inLength = stack->Parameters.DeviceIoControl.InputBufferLength;
    ULONG outLength = stack->Parameters.DeviceIoControl.OutputBufferLength;
    PVOID buffer = irp->AssociatedIrp.SystemBuffer;

    NTSTATUS status = STATUS_INVALID_DEVICE_REQUEST;
    ULONG written = 0;

    switch (code) {
        case IOCTL_DSHSHOT_CLEAR:
            if (inLength >= sizeof(DSHSHOT_REQUEST)) {
                status = HandleClear((PDSHSHOT_REQUEST)buffer);
            } else {
                status = STATUS_BUFFER_TOO_SMALL;
            }
            break;
        case IOCTL_DSHSHOT_GUARD:
            if (inLength >= sizeof(DSHSHOT_REQUEST)) {
                status = HandleGuard((PDSHSHOT_REQUEST)buffer);
            } else {
                status = STATUS_BUFFER_TOO_SMALL;
            }
            break;
        case IOCTL_DSHSHOT_STATUS:
            if (outLength >= sizeof(DSHSHOT_STATUS)) {
                RtlCopyMemory(buffer, &g_status, sizeof(DSHSHOT_STATUS));
                written = sizeof(DSHSHOT_STATUS);
                status = STATUS_SUCCESS;
            } else {
                status = STATUS_BUFFER_TOO_SMALL;
            }
            break;
        default:
            break;
    }

    irp->IoStatus.Status = status;
    irp->IoStatus.Information = written;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return status;
}

static NTSTATUS DeviceCreate(PDEVICE_OBJECT device, PIRP irp) {
    UNREFERENCED_PARAMETER(device);
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static NTSTATUS DeviceClose(PDEVICE_OBJECT device, PIRP irp) {
    UNREFERENCED_PARAMETER(device);
    irp->IoStatus.Status = STATUS_SUCCESS;
    irp->IoStatus.Information = 0;
    IoCompleteRequest(irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static VOID DriverUnload(PDRIVER_OBJECT driver) {
    // Stop an in-flight guard sweep before the image goes away.
    PGUARD_CONTEXT guard = (PGUARD_CONTEXT)g_guardContext;
    if (guard != NULL) {
        InterlockedExchange(&guard->Stop, 1);
        LARGE_INTEGER delay;
        delay.QuadPart = -100000LL;  // 10 ms
        for (int i = 0; i < 200 && InterlockedCompareExchangePointer((PVOID*)&g_guardContext, NULL, guard) != NULL; ++i) {
            KeDelayExecutionThread(KernelMode, FALSE, &delay);
        }
    }

    UNICODE_STRING symlink;
    RtlInitUnicodeString(&symlink, DSHSHOT_SYMLINK_NAME);
    IoDeleteSymbolicLink(&symlink);
    if (g_device != NULL) {
        IoDeleteDevice(g_device);
        g_device = NULL;
    }
    UNREFERENCED_PARAMETER(driver);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driver, PUNICODE_STRING registryPath) {
    UNREFERENCED_PARAMETER(registryPath);
    RtlZeroMemory(&g_status, sizeof(g_status));

    // ZwCreateThreadEx / ZwTerminateThread are not part of ntoskrnl.lib's
    // import set; resolve them the supported way at load time.
    g_ZwCreateThreadEx = (PFN_ZWCREATETHREADEX)ResolveRoutine(L"ZwCreateThreadEx");
    g_ZwTerminateThread = (PFN_ZWTERMINATETHREAD)ResolveRoutine(L"ZwTerminateThread");
    if (g_ZwCreateThreadEx == NULL || g_ZwTerminateThread == NULL) {
        return STATUS_PROCEDURE_NOT_FOUND;
    }

    UNICODE_STRING deviceName;
    RtlInitUnicodeString(&deviceName, DSHSHOT_DEVICE_NAME);
    NTSTATUS status = IoCreateDevice(driver, 0, &deviceName, FILE_DEVICE_UNKNOWN,
                                     FILE_DEVICE_SECURE_OPEN, FALSE, &g_device);
    if (!NT_SUCCESS(status)) return status;

    UNICODE_STRING symlink;
    RtlInitUnicodeString(&symlink, DSHSHOT_SYMLINK_NAME);
    status = IoCreateSymbolicLink(&symlink, &deviceName);
    if (!NT_SUCCESS(status)) {
        IoDeleteDevice(g_device);
        g_device = NULL;
        return status;
    }

    driver->MajorFunction[IRP_MJ_CREATE] = DeviceCreate;
    driver->MajorFunction[IRP_MJ_CLOSE] = DeviceClose;
    driver->MajorFunction[IRP_MJ_DEVICE_CONTROL] = DeviceControl;
    driver->DriverUnload = DriverUnload;
    return STATUS_SUCCESS;
}