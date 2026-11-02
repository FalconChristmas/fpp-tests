/* fakefree.so: LD_PRELOAD into php-fpm to make the disk look as full as a
 * test needs.  While FREE_CONTROL (default /tmp/fpp-tests-free) holds a
 * number of bytes, statvfs() and statvfs64() report that much free space on
 * every path (PHP's disk_free_space() is f_frsize * f_bavail).  The control
 * file is read on each call, so a test changes the figure without restarting
 * php-fpm.  The container has no block devices to mount a small filesystem
 * on, which is how a player's nearly full media drive would be made.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/statvfs.h>
#include <unistd.h>

static long long wanted(void) {
    static int (*real_open)(const char*, int, ...);
    if (!real_open)
        real_open = dlsym(RTLD_NEXT, "open");
    const char* c = getenv("FREE_CONTROL");
    int fd = real_open(c && *c ? c : "/tmp/fpp-tests-free", O_RDONLY);
    if (fd < 0)
        return -1;
    char buf[64];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0)
        return -1;
    buf[n] = '\0';
    return atoll(buf);
}

int statvfs(const char* path, struct statvfs* st) {
    static int (*real)(const char*, struct statvfs*);
    if (!real)
        real = dlsym(RTLD_NEXT, "statvfs");
    int r = real(path, st);
    long long w = wanted();
    if (r == 0 && w >= 0) {
        if (!st->f_frsize)
            st->f_frsize = 4096;
        st->f_bavail = st->f_bfree = w / st->f_frsize;
    }
    return r;
}

int statvfs64(const char* path, struct statvfs64* st) {
    static int (*real)(const char*, struct statvfs64*);
    if (!real)
        real = dlsym(RTLD_NEXT, "statvfs64");
    int r = real(path, st);
    long long w = wanted();
    if (r == 0 && w >= 0) {
        if (!st->f_frsize)
            st->f_frsize = 4096;
        st->f_bavail = st->f_bfree = w / st->f_frsize;
    }
    return r;
}
