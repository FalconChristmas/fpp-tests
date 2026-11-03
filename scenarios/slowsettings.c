/* slowsettings.so: LD_PRELOAD into fppd to make saving one setting slow.
 * Once the file named by SLOWSET_ARM exists, an open() of the media settings
 * file for writing (O_RDWR or O_WRONLY -- how persistSetting() opens it; a
 * reload opens it read-only) waits SLOWSET_MS (default 20) first. That holds
 * setSetting(persist) between its in-memory update and its file write.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void maybe_wait(const char* path, int flags) {
    const char* arm = getenv("SLOWSET_ARM");
    if (!path || !arm || (flags & O_ACCMODE) == O_RDONLY || access(arm, F_OK) != 0) {
        return;
    }
    const char* base = strrchr(path, '/');
    base = base ? base + 1 : path;
    if (strcmp(base, "settings") == 0) {
        const char* ms = getenv("SLOWSET_MS");
        usleep((ms ? atoi(ms) : 20) * 1000);
    }
}

static int call_open(const char* sym, const char* path, int flags, va_list ap) {
    int (*real)(const char*, int, ...) = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, sym);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        mode = va_arg(ap, mode_t);
    }
    maybe_wait(path, flags);
    return real(path, flags, mode);
}

int open(const char* path, int flags, ...) {
    va_list ap;
    va_start(ap, flags);
    int fd = call_open("open", path, flags, ap);
    va_end(ap);
    return fd;
}

int open64(const char* path, int flags, ...) {
    va_list ap;
    va_start(ap, flags);
    int fd = call_open("open64", path, flags, ap);
    va_end(ap);
    return fd;
}
