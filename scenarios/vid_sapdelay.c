/* vid_sapdelay.so: LD_PRELOAD into fppd to widen the window between
 * VideoOutputManager::StartSAPAnnouncer() setting its running flag and
 * assigning the announcer's std::thread.  Every pthread_create() whose
 * caller is StartSAPAnnouncer (found by walking the stack and naming each
 * frame with dladdr) sleeps SAPDELAY_MS (default 300) first.  A
 * StopSAPAnnouncer() from another thread then lands inside the window
 * whenever the two overlap, rather than once in a long while.
 *
 * Under a sanitizer, the runtime's own pthread_create interceptor comes
 * first and calls this one as the "real" function, so the stack still runs
 * through StartSAPAnnouncer.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*create_fn)(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);

static int from_sap_start(void) {
    void* frames[16];
    int n = backtrace(frames, 16);
    for (int i = 1; i < n; i++) {
        Dl_info info;
        if (dladdr(frames[i], &info) && info.dli_sname && strstr(info.dli_sname, "StartSAPAnnouncer")) {
            return 1;
        }
    }
    return 0;
}

int pthread_create(pthread_t* t, const pthread_attr_t* attr, void* (*fn)(void*), void* arg) {
    static create_fn real;
    if (!real) {
        real = (create_fn)dlsym(RTLD_NEXT, "pthread_create");
    }
    if (from_sap_start()) {
        const char* ms = getenv("SAPDELAY_MS");
        usleep((ms ? atoi(ms) : 300) * 1000);
    }
    return real(t, attr, fn, arg);
}
