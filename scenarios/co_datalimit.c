/* co_datalimit.so: LD_PRELOAD into fppd to cap its data (RLIMIT_DATA: heap
 * and private writable mappings) at $CO_DATALIMIT_MB megabytes, so an
 * allocation that would grow until the machine runs out of memory fails with
 * ENOMEM (std::bad_alloc) instead -- on a device, before the OOM killer
 * picks something else.
 */
#include <stdlib.h>
#include <sys/resource.h>

__attribute__((constructor)) static void co_datalimit(void) {
    const char* mb = getenv("CO_DATALIMIT_MB");
    if (mb) {
        struct rlimit r;
        r.rlim_cur = r.rlim_max = (rlim_t)atol(mb) * 1024 * 1024;
        setrlimit(RLIMIT_DATA, &r);
    }
}
