/* life_staticthread.so: LD_PRELOAD into fppd to put a file-static
 * std::thread in the process that is still running, and so joinable, when
 * the process exits -- the shape of the crash-prone statics fppd used to
 * have (the Events publish thread, the warnings notify thread).  With
 * $LIFE_STATIC_THREAD set it is started as this object loads and never
 * joined, in fppd only (not the shells and tools it runs, which inherit
 * the preload).  Its destructor runs only if the exit runs the C++ global
 * destructors, and then calls std::terminate.
 */
#include <stdlib.h>
#include <string.h>
#include <thread>
#include <unistd.h>

static bool in_fppd() {
    char exe[4096];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (n <= 0) {
        return false;
    }
    exe[n] = '\0';
    const char* base = strrchr(exe, '/');
    return base && strcmp(base, "/fppd") == 0;
}

static std::thread started() {
    if (!getenv("LIFE_STATIC_THREAD") || !in_fppd()) {
        return std::thread();
    }
    return std::thread([] {
        for (;;) {
            pause();
        }
    });
}

static std::thread lingering = started();
