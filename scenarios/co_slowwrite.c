/* co_slowwrite.so: LD_PRELOAD into fppd to make writes to one device slow,
 * the way a slow serial line or a busy USB adapter is.  write() to an fd
 * open on $CO_SLOWWRITE_DEVICE (a path such as /dev/pts/3) sleeps
 * $CO_SLOWWRITE_MS (default 100) first.  An output worker held there has its
 * next frame queued behind it by the time it gets back.  (Matched by device,
 * not thread name: an output's "FPP-<type>" thread name is often longer than
 * the kernel's 15 characters, and then it is never set.)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

ssize_t write(int fd, const void* buf, size_t count) {
    static ssize_t (*real)(int, const void*, size_t);
    if (!real) {
        real = (ssize_t(*)(int, const void*, size_t))dlsym(RTLD_NEXT, "write");
    }
    const char* want = getenv("CO_SLOWWRITE_DEVICE");
    if (want && *want && fd > 2) {
        char link[64], path[256];
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(link, path, sizeof(path) - 1);
        if (n > 0) {
            path[n] = 0;
            if (strcmp(path, want) == 0) {
                const char* ms = getenv("CO_SLOWWRITE_MS");
                usleep((ms ? atoi(ms) : 100) * 1000);
            }
        }
    }
    return real(fd, buf, count);
}
