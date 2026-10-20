/* slowflock.so: LD_PRELOAD into fppd to hold up one file write at its lock.
 * The first flock(LOCK_EX) on a file whose path ends in $SLOWFLOCK_SUFFIX,
 * made while $SLOWFLOCK_FLAG exists, removes the flag and waits
 * SLOWFLOCK_MS (default 1500) before locking.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

int flock(int fd, int op) {
    static int (*real)(int, int);
    if (!real) {
        real = (int (*)(int, int))dlsym(RTLD_NEXT, "flock");
    }
    const char* suffix = getenv("SLOWFLOCK_SUFFIX");
    const char* flag = getenv("SLOWFLOCK_FLAG");
    if ((op & LOCK_EX) && suffix && flag) {
        char link[64], path[1024];
        snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
        ssize_t n = readlink(link, path, sizeof(path) - 1);
        size_t sl = strlen(suffix);
        if (n >= (ssize_t)sl) {
            path[n] = 0;
            if (strcmp(path + n - sl, suffix) == 0 && unlink(flag) == 0) {
                const char* ms = getenv("SLOWFLOCK_MS");
                usleep((ms ? atoi(ms) : 1500) * 1000);
            }
        }
    }
    return real(fd, op);
}
