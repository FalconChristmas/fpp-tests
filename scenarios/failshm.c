/* failshm.so: LD_PRELOAD into fppd to make shm_open() fail with EACCES for
 * every name that starts with $FAILSHM_PREFIX, as it does on a box whose
 * /dev/shm is full or mounted read-only.  Other names, and every other call,
 * go through untouched.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/types.h>

int shm_open(const char* name, int oflag, mode_t mode) {
    static int (*real)(const char*, int, mode_t);
    if (!real) {
        real = (int (*)(const char*, int, mode_t))dlsym(RTLD_NEXT, "shm_open");
    }
    const char* prefix = getenv("FAILSHM_PREFIX");
    if (prefix && name && strncmp(name, prefix, strlen(prefix)) == 0) {
        errno = EACCES;
        return -1;
    }
    return real(name, oflag, mode);
}
