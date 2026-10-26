/* fakedeny.so: LD_PRELOAD into php-fpm to make files unwritable or
 * unreadable to it.
 * The web container's php-fpm runs as root, which every permission check
 * lets through, so a settings file a player's fpp user can't write (one a
 * stray root write left root's) can't be set up with chown or chmod.  While
 * DENY_CONTROL (default /tmp/fpp-tests-deny) has a "write <path>" line, an
 * open of that path for writing fails with EACCES, as it does for the fpp
 * user; a "read <path>" line refuses every open of it.  Other paths go
 * through.  A path is compared resolved too, as PHP opens it.  The control
 * file is read on each call, so the test turns a denial on and off without
 * restarting php-fpm.
 *
 * The calls are the ones PHP's plain-file wrapper opens files with: open,
 * open64, openat, openat64, fopen and fopen64.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char* control(void) {
    const char* c = getenv("DENY_CONTROL");
    return c && *c ? c : "/tmp/fpp-tests-deny";
}

/* Whether an open of `path`, for writing if `writing`, is refused: the
 * control file holds "write <path>" lines (refuse write opens) and "read
 * <path>" lines (refuse every open).  It is read with the real open, so this
 * never recurses. */
static int denied(const char* path, int writing) {
    static int (*real_open)(const char*, int, ...);
    if (!real_open)
        real_open = dlsym(RTLD_NEXT, "open");
    if (!path)
        return 0;
    int fd = real_open(control(), O_RDONLY);
    if (fd < 0)
        return 0;
    char buf[8192];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0)
        return 0;
    buf[n] = '\0';
    char resolved[4096];
    int haveResolved = realpath(path, resolved) != NULL;
    char* save = NULL;
    for (char* line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        const char* p;
        if (strncmp(line, "read ", 5) == 0)
            p = line + 5;
        else if (writing && strncmp(line, "write ", 6) == 0)
            p = line + 6;
        else
            continue;
        if (strcmp(p, path) == 0)
            return 1;
        /* PHP opens the resolved path: the media directory is a symlink. */
        char a[4096];
        if (haveResolved && realpath(p, a) && strcmp(a, resolved) == 0)
            return 1;
    }
    return 0;
}

static int writes(int flags) {
    return (flags & O_ACCMODE) != O_RDONLY || (flags & (O_CREAT | O_TRUNC));
}

static int fwrites(const char* mode) {
    return mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+'));
}

#define OPEN(name)                                                        \
    int name(const char* path, int flags, ...) {                          \
        static int (*real)(const char*, int, ...);                        \
        if (!real)                                                        \
            real = dlsym(RTLD_NEXT, #name);                               \
        mode_t mode = 0;                                                  \
        if (flags & (O_CREAT | O_TMPFILE)) {                              \
            va_list ap;                                                   \
            va_start(ap, flags);                                          \
            mode = va_arg(ap, mode_t);                                    \
            va_end(ap);                                                   \
        }                                                                 \
        if (denied(path, writes(flags))) {                              \
            errno = EACCES;                                               \
            return -1;                                                    \
        }                                                                 \
        return real(path, flags, mode);                                   \
    }
OPEN(open)
OPEN(open64)

#define OPENAT(name)                                                      \
    int name(int dirfd, const char* path, int flags, ...) {               \
        static int (*real)(int, const char*, int, ...);                   \
        if (!real)                                                        \
            real = dlsym(RTLD_NEXT, #name);                               \
        mode_t mode = 0;                                                  \
        if (flags & (O_CREAT | O_TMPFILE)) {                              \
            va_list ap;                                                   \
            va_start(ap, flags);                                          \
            mode = va_arg(ap, mode_t);                                    \
            va_end(ap);                                                   \
        }                                                                 \
        if (denied(path, writes(flags))) {                              \
            errno = EACCES;                                               \
            return -1;                                                    \
        }                                                                 \
        return real(dirfd, path, flags, mode);                            \
    }
OPENAT(openat)
OPENAT(openat64)

#define FOPEN(name)                                                       \
    FILE* name(const char* path, const char* mode) {                      \
        static FILE* (*real)(const char*, const char*);                   \
        if (!real)                                                        \
            real = dlsym(RTLD_NEXT, #name);                               \
        if (denied(path, fwrites(mode))) {                              \
            errno = EACCES;                                               \
            return NULL;                                                  \
        }                                                                 \
        return real(path, mode);                                          \
    }
FOPEN(fopen)
FOPEN(fopen64)
