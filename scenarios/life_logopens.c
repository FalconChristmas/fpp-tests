/* life_logopens.so: LD_PRELOAD into fppd to count how often it opens its log
 * file.  Every fopen(), fopen64(), open() or open64() of a path ending in
 * /fppd.log appends one line, "<mode or flags> <path>", to $LIFE_LOGOPENS_LOG.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int (*real_open)(const char*, int, ...);

static void note(const char* path, const char* how) {
    const char* out = getenv("LIFE_LOGOPENS_LOG");
    size_t len = path ? strlen(path) : 0, want = strlen("/fppd.log");
    if (!out || len < want || strcmp(path + len - want, "/fppd.log") != 0) {
        return;
    }
    if (!real_open) {
        real_open = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, "open");
    }
    char line[4200];
    int n = snprintf(line, sizeof(line), "%s %s\n", how, path);
    int fd = real_open(out, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    if (fd >= 0) {
        (void)!write(fd, line, n);
        close(fd);
    }
}

FILE* fopen(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    }
    note(path, mode);
    return real(path, mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    }
    note(path, mode);
    return real(path, mode);
}

static int open_common(const char* name, const char* path, int flags, va_list ap) {
    int (*real)(const char*, int, ...) = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, name);
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        m = va_arg(ap, mode_t);
    }
    char how[32];
    snprintf(how, sizeof(how), "flags=%#x", flags);
    note(path, how);
    return real(path, flags, m);
}

int open(const char* path, int flags, ...) {
    va_list ap;
    va_start(ap, flags);
    int rc = open_common("open", path, flags, ap);
    va_end(ap);
    return rc;
}

int open64(const char* path, int flags, ...) {
    va_list ap;
    va_start(ap, flags);
    int rc = open_common("open64", path, flags, ap);
    va_end(ap);
    return rc;
}
