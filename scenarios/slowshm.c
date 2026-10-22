/* slowshm.so: LD_PRELOAD into fppd to make shm_open() slow, as it is on a
 * busy box, for every name that starts with $SLOWSHM_PREFIX: it waits
 * $SLOWSHM_MS (default 500) first.  Other names, and every other call, go
 * through untouched.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <unistd.h>

int shm_open(const char* name, int oflag, mode_t mode) {
    static int (*real)(const char*, int, mode_t);
    if (!real) {
        real = (int (*)(const char*, int, mode_t))dlsym(RTLD_NEXT, "shm_open");
    }
    const char* prefix = getenv("SLOWSHM_PREFIX");
    if (prefix && name && strncmp(name, prefix, strlen(prefix)) == 0) {
        const char* ms = getenv("SLOWSHM_MS");
        usleep((ms ? atoi(ms) : 500) * 1000);
    }
    return real(name, oflag, mode);
}
