/* failstat_afteropen.so: LD_PRELOAD into fppd to make the stat() that
 * follows a read of a given file fail, as when the file is replaced between
 * the read and the stat.  While the file $FAILSTAT_ARM exists, an fopen() of
 * a path ending in $FAILSTAT_SUFFIX arms one failure: the next stat() of
 * that path returns -1 (ENOENT).  A failed stat() leaves its buffer as it
 * was -- stack garbage, in the caller -- so this one fills it with 0x7f
 * bytes, making that garbage the same on every run: an mtime far in the
 * future.  Every other call goes through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int armed;

static int matches(const char* path) {
    const char* suffix = getenv("FAILSTAT_SUFFIX");
    if (!suffix || !path)
        return 0;
    size_t n = strlen(path), m = strlen(suffix);
    return n >= m && strcmp(path + n - m, suffix) == 0;
}

static void maybe_arm(const char* path) {
    const char* arm = getenv("FAILSTAT_ARM");
    if (arm && matches(path) && access(arm, F_OK) == 0)
        __atomic_store_n(&armed, 1, __ATOMIC_SEQ_CST);
}

static int maybe_fail(const char* path, void* buf, size_t size) {
    if (!matches(path) || !__atomic_exchange_n(&armed, 0, __ATOMIC_SEQ_CST))
        return 0;
    memset(buf, 0x7f, size);
    errno = ENOENT;
    return 1;
}

FILE* fopen(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    maybe_arm(path);
    return real(path, mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    maybe_arm(path);
    return real(path, mode);
}

int stat(const char* path, struct stat* buf) {
    static int (*real)(const char*, struct stat*);
    if (!real)
        real = (int (*)(const char*, struct stat*))dlsym(RTLD_NEXT, "stat");
    if (maybe_fail(path, buf, sizeof(*buf)))
        return -1;
    return real(path, buf);
}

int stat64(const char* path, struct stat64* buf) {
    static int (*real)(const char*, struct stat64*);
    if (!real)
        real = (int (*)(const char*, struct stat64*))dlsym(RTLD_NEXT, "stat64");
    if (maybe_fail(path, buf, sizeof(*buf)))
        return -1;
    return real(path, buf);
}
