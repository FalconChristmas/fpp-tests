/* smallmem.so: LD_PRELOAD into a program to have sysconf(_SC_PHYS_PAGES)
 * report $SMALLMEM_MB megabytes of RAM (default 512), as on a BeagleBone.
 * FPP sizes some buffers from it; every other sysconf() name is answered
 * as usual.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <unistd.h>

long sysconf(int name) {
    static long (*real)(int);
    if (!real) {
        real = (long (*)(int))dlsym(RTLD_NEXT, "sysconf");
    }
    if (name == _SC_PHYS_PAGES) {
        const char* mb = getenv("SMALLMEM_MB");
        long page = real(_SC_PAGESIZE);
        return (long)((mb && *mb ? atol(mb) : 512) * 1024L * 1024L / (page > 0 ? page : 4096));
    }
    return real(name);
}
