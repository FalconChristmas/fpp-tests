/* fakemem.so: LD_PRELOAD into fppd to make it see a smaller machine.
 * sysconf(_SC_PHYS_PAGES) answers FAKEMEM_MB (default 512) megabytes'
 * worth of pages, as on a 512 MB BeagleBone or PocketBeagle 2.
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
        const char* mb = getenv("FAKEMEM_MB");
        long page = real(_SC_PAGESIZE);
        return (mb ? atol(mb) : 512) * 1024L * 1024L / (page > 0 ? page : 4096);
    }
    return real(name);
}
