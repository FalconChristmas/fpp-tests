/* noipv6.so: the view of a kernel with no IPv6 (booted with ipv6.disable=1,
 * or without the ipv6 module), for a program run with it preloaded:
 * socket(AF_INET6, ...) fails with EAFNOSUPPORT, and /proc/sys/net/ipv6 --
 * what FPP's Apache config and envvars test for IPv6 -- is not there.
 *
 * Built and preloaded by apache-listener-no-ipv6.spec.ts, into apache2ctl and
 * so into the shell that sources envvars and the apache2 it runs. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static const char GONE[] = "/proc/sys/net/ipv6";

static int gone(const char *path) {
    return path && strncmp(path, GONE, sizeof(GONE) - 1) == 0 &&
           (path[sizeof(GONE) - 1] == '\0' || path[sizeof(GONE) - 1] == '/');
}

#define REAL(name) static __typeof__(name) *real_##name; \
    if (!real_##name) real_##name = (__typeof__(name) *)dlsym(RTLD_NEXT, #name)

int socket(int domain, int type, int protocol) {
    REAL(socket);
    if (domain == AF_INET6) {
        errno = EAFNOSUPPORT;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

int stat(const char *path, struct stat *st) {
    REAL(stat);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_stat(path, st);
}

int lstat(const char *path, struct stat *st) {
    REAL(lstat);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_lstat(path, st);
}

int fstatat(int dirfd, const char *path, struct stat *st, int flags) {
    REAL(fstatat);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_fstatat(dirfd, path, st, flags);
}

int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *st) {
    REAL(statx);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_statx(dirfd, path, flags, mask, st);
}

int access(const char *path, int mode) {
    REAL(access);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_access(path, mode);
}

int faccessat(int dirfd, const char *path, int mode, int flags) {
    REAL(faccessat);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_faccessat(dirfd, path, mode, flags);
}

/* The shell that sources envvars (dash) is built with 64-bit file offsets
 * and calls these. */
int stat64(const char *path, struct stat64 *st) {
    REAL(stat64);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_stat64(path, st);
}

int lstat64(const char *path, struct stat64 *st) {
    REAL(lstat64);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_lstat64(path, st);
}

int fstatat64(int dirfd, const char *path, struct stat64 *st, int flags) {
    REAL(fstatat64);
    if (gone(path)) { errno = ENOENT; return -1; }
    return real_fstatat64(dirfd, path, st, flags);
}
