/* fakeasound.so: LD_PRELOAD into php-fpm to give the web container sound
 * cards.  It has no /proc/asound (Docker's kernel has no ALSA), and procfs
 * takes no directories, so the PHP that looks a card up there never finds
 * one.  This sends every path under /proc/asound to a plain directory the
 * test fills in instead (FAKE_ASOUND, default /tmp/fpp-tests-fakeasound): the
 * cards list, cardN/id and the <id> -> cardN links.  glob() results are
 * handed back under /proc/asound, as the PHP expects to see them.
 *
 * Also /sys/class/drm, for the display connectors, which Docker's sysfs has
 * none of and takes no files: sent to /tmp/fpp-tests-fakedrm, but only while
 * that directory exists, so the real one is seen otherwise.
 *
 * The calls are the ones php-fpm8.4 imports for file access: open, fopen,
 * stat, lstat, access, readlink, opendir, scandir and glob.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <glob.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define PROC "/proc/asound"

static const char* root(void) {
    const char* r = getenv("FAKE_ASOUND");
    return r && *r ? r : "/tmp/fpp-tests-fakeasound";
}

#define DRM "/sys/class/drm"
#define FAKE_DRM "/tmp/fpp-tests-fakedrm"

static int under(const char* path, const char* dir) {
    size_t n = strlen(dir);
    return path && strncmp(path, dir, n) == 0 && (path[n] == '\0' || path[n] == '/');
}

static int (*real_access_fn)(const char*, int);

/* `path` under /proc/asound (or /sys/class/drm while FAKE_DRM exists),
 * rewritten into `buf`; otherwise `path` itself. */
static const char* fake(const char* path, char* buf, size_t len) {
    if (under(path, PROC)) {
        snprintf(buf, len, "%s%s", root(), path + strlen(PROC));
        return buf;
    }
    if (under(path, DRM)) {
        if (!real_access_fn)
            real_access_fn = (int (*)(const char*, int))dlsym(RTLD_NEXT, "access");
        if (real_access_fn(FAKE_DRM, F_OK) == 0) {
            snprintf(buf, len, "%s%s", FAKE_DRM, path + strlen(DRM));
            return buf;
        }
    }
    return path;
}

#define REAL(name) static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

int open(const char* path, int flags, ...) {
    REAL(open);
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, mode_t);
        va_end(ap);
    }
    char buf[4096];
    return real_open(fake(path, buf, sizeof(buf)), flags, mode);
}

FILE* fopen(const char* path, const char* mode) {
    REAL(fopen);
    char buf[4096];
    return real_fopen(fake(path, buf, sizeof(buf)), mode);
}

int stat(const char* path, struct stat* st) {
    REAL(stat);
    char buf[4096];
    return real_stat(fake(path, buf, sizeof(buf)), st);
}

int lstat(const char* path, struct stat* st) {
    REAL(lstat);
    char buf[4096];
    return real_lstat(fake(path, buf, sizeof(buf)), st);
}

int access(const char* path, int mode) {
    REAL(access);
    char buf[4096];
    return real_access(fake(path, buf, sizeof(buf)), mode);
}

ssize_t readlink(const char* path, char* out, size_t len) {
    REAL(readlink);
    char buf[4096];
    return real_readlink(fake(path, buf, sizeof(buf)), out, len);
}

DIR* opendir(const char* path) {
    REAL(opendir);
    char buf[4096];
    return real_opendir(fake(path, buf, sizeof(buf)));
}

int scandir(const char* path, struct dirent*** list, int (*sel)(const struct dirent*),
            int (*cmp)(const struct dirent**, const struct dirent**)) {
    REAL(scandir);
    char buf[4096];
    return real_scandir(fake(path, buf, sizeof(buf)), list, sel, cmp);
}

int glob(const char* pattern, int flags, int (*err)(const char*, int), glob_t* g) {
    REAL(glob);
    char buf[4096];
    const char* p = fake(pattern, buf, sizeof(buf));
    int rc = real_glob(p, flags, err, g);
    if (p == pattern || rc != 0)
        return rc;
    size_t n = strlen(root());
    for (size_t i = g->gl_offs; i < g->gl_offs + g->gl_pathc; i++) {
        char* s = g->gl_pathv[i];
        if (!s || strncmp(s, root(), n) != 0)
            continue;
        char* back = malloc(strlen(PROC) + strlen(s + n) + 1);
        if (!back)
            continue;
        strcpy(back, PROC);
        strcat(back, s + n);
        free(s);
        g->gl_pathv[i] = back;
    }
    return rc;
}
