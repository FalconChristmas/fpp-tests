/* co_failprumap.so: LD_PRELOAD into fppd to make every anonymous mmap() of
 * exactly $CO_FAILPRUMAP_LEN bytes fail with ENOMEM, as the PRU
 * memory mappings do once fppd has run out of file descriptors.  On an AM62x
 * in FAKE_PRU mode the PRUSS window is such a mapping (0x80000 bytes).
 * $CO_FAILPRUMAP_SKIP (default 0) such mappings are let through first.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/types.h>

static void* fail_or(void* (*real)(void*, size_t, int, int, int, off_t), void* addr, size_t len,
                     int prot, int flags, int fd, off_t off) {
    static int seen;
    const char* want = getenv("CO_FAILPRUMAP_LEN");
    const char* skip = getenv("CO_FAILPRUMAP_SKIP");
    if (want && (flags & MAP_ANONYMOUS) && len == strtoul(want, NULL, 0) &&
        __atomic_fetch_add(&seen, 1, __ATOMIC_RELAXED) >= (skip ? atoi(skip) : 0)) {
        errno = ENOMEM;
        return MAP_FAILED;
    }
    return real(addr, len, prot, flags, fd, off);
}

/* fppd is built with 64-bit file offsets, so it calls mmap64 */
void* mmap64(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    static void* (*real)(void*, size_t, int, int, int, off_t);
    if (!real) {
        real = (void* (*)(void*, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap64");
    }
    return fail_or(real, addr, len, prot, flags, fd, off);
}

void* mmap(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    static void* (*real)(void*, size_t, int, int, int, off_t);
    if (!real) {
        real = (void* (*)(void*, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap");
    }
    return fail_or(real, addr, len, prot, flags, fd, off);
}
