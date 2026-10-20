/* fakesys.so: LD_PRELOAD into fppd to serve parts of /sys (or any tree) from
 * a scratch directory, so a scenario can hand fppd the sysfs files of
 * hardware the container doesn't have -- thermal zones, hwmon fans.
 *
 * FAKESYS="<from>=<to>[:<from>=<to>...]": a path that is <from> or starts
 * with <from>/ is opened as <to> plus the rest.  The real <from> disappears
 * with it: whatever the host has there is never seen, so a scenario only
 * ever sees the files it wrote.
 *
 * stat() (FileExists), open()/openat() and fopen() are rewritten, each in
 * its plain and 64-bit spellings: which one fppd calls depends on the
 * platform's _FILE_OFFSET_BITS, as in cardwrap.c.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_MAPS 8

static struct {
    char from[256];
    char to[256];
} maps[MAX_MAPS];
static int nmaps = -1;

static void load_maps(void) {
    nmaps = 0;
    const char* env = getenv("FAKESYS");
    if (!env) return;
    char buf[2048];
    snprintf(buf, sizeof(buf), "%s", env);
    char* save = NULL;
    for (char* tok = strtok_r(buf, ":", &save); tok && nmaps < MAX_MAPS; tok = strtok_r(NULL, ":", &save)) {
        char* eq = strchr(tok, '=');
        if (!eq) continue;
        *eq = 0;
        snprintf(maps[nmaps].from, sizeof(maps[nmaps].from), "%s", tok);
        snprintf(maps[nmaps].to, sizeof(maps[nmaps].to), "%s", eq + 1);
        nmaps++;
    }
}

/* The path fppd should really open: `path` itself, or its rewrite in `out`. */
static const char* map(const char* path, char* out, size_t len) {
    if (nmaps < 0) load_maps();
    if (!path) return path;
    for (int i = 0; i < nmaps; i++) {
        size_t n = strlen(maps[i].from);
        if (strncmp(path, maps[i].from, n) == 0 && (path[n] == 0 || path[n] == '/')) {
            snprintf(out, len, "%s%s", maps[i].to, path + n);
            return out;
        }
    }
    return path;
}

#define REAL(name) \
    static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

int stat(const char* path, struct stat* st) {
    REAL(stat);
    char buf[512];
    return real_stat(map(path, buf, sizeof(buf)), st);
}

int lstat(const char* path, struct stat* st) {
    REAL(lstat);
    char buf[512];
    return real_lstat(map(path, buf, sizeof(buf)), st);
}

int stat64(const char* path, struct stat64* st) {
    REAL(stat64);
    char buf[512];
    return real_stat64(map(path, buf, sizeof(buf)), st);
}

int lstat64(const char* path, struct stat64* st) {
    REAL(lstat64);
    char buf[512];
    return real_lstat64(map(path, buf, sizeof(buf)), st);
}

int access(const char* path, int mode) {
    REAL(access);
    char buf[512];
    return real_access(map(path, buf, sizeof(buf)), mode);
}

static mode_t mode_arg(int flags, va_list ap) {
    return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(ap, int) : 0;
}

int open(const char* path, int flags, ...) {
    REAL(open);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    char buf[512];
    return real_open(map(path, buf, sizeof(buf)), flags, mode);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    char buf[512];
    return real_open64(map(path, buf, sizeof(buf)), flags, mode);
}

int openat(int dirfd, const char* path, int flags, ...) {
    REAL(openat);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    char buf[512];
    return real_openat(dirfd, map(path, buf, sizeof(buf)), flags, mode);
}

int openat64(int dirfd, const char* path, int flags, ...) {
    REAL(openat64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    char buf[512];
    return real_openat64(dirfd, map(path, buf, sizeof(buf)), flags, mode);
}

FILE* fopen(const char* path, const char* how) {
    REAL(fopen);
    char buf[512];
    return real_fopen(map(path, buf, sizeof(buf)), how);
}

FILE* fopen64(const char* path, const char* how) {
    REAL(fopen64);
    char buf[512];
    return real_fopen64(map(path, buf, sizeof(buf)), how);
}

DIR* opendir(const char* path) {
    REAL(opendir);
    char buf[512];
    return real_opendir(map(path, buf, sizeof(buf)));
}
