/* slowwarnings.so: LD_PRELOAD into fppd to make writing the warnings files
 * (www/warnings.json, www/warnings_full.json) slow, as on a busy SD card.
 * Once the file named by SLOWWARN_ARM exists, open() of either waits
 * SLOWWARN_MS (default 3000) first.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void maybe_wait(const char* path) {
    const char* arm = getenv("SLOWWARN_ARM");
    if (!path || !arm || access(arm, F_OK) != 0) {
        return;
    }
    const char* base = strrchr(path, '/');
    base = base ? base + 1 : path;
    if (strcmp(base, "warnings.json") == 0 || strcmp(base, "warnings_full.json") == 0) {
        const char* ms = getenv("SLOWWARN_MS");
        usleep((ms ? atoi(ms) : 3000) * 1000);
    }
}

static int call_open(const char* sym, const char* path, int flags, va_list ap) {
    int (*real)(const char*, int, ...) = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, sym);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        mode = va_arg(ap, mode_t);
    }
    maybe_wait(path);
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
