/* nocontainer.so: LD_PRELOAD into fppd to hide /etc/fpp/container, the file
 * the test image carries so FPP's makefiles and fppd know they run in a
 * container. With it hidden, fppd takes the code paths it takes on a
 * player, for a scenario that checks what those do (they send their
 * requests to a stand-in, not to a real system).
 *
 * stat() and access() of exactly that path fail with ENOENT; everything
 * else is passed through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char HIDDEN[] = "/etc/fpp/container";

static int hidden(const char* path) {
    return path && strcmp(path, HIDDEN) == 0;
}

int stat(const char* path, struct stat* st) {
    static int (*real)(const char*, struct stat*);
    if (hidden(path)) {
        errno = ENOENT;
        return -1;
    }
    if (!real)
        real = (int (*)(const char*, struct stat*))dlsym(RTLD_NEXT, "stat");
    return real(path, st);
}

int stat64(const char* path, struct stat64* st) {
    static int (*real)(const char*, struct stat64*);
    if (hidden(path)) {
        errno = ENOENT;
        return -1;
    }
    if (!real)
        real = (int (*)(const char*, struct stat64*))dlsym(RTLD_NEXT, "stat64");
    return real(path, st);
}

int access(const char* path, int mode) {
    static int (*real)(const char*, int);
    if (hidden(path)) {
        errno = ENOENT;
        return -1;
    }
    if (!real)
        real = (int (*)(const char*, int))dlsym(RTLD_NEXT, "access");
    return real(path, mode);
}
