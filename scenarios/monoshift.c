/* monoshift.so: LD_PRELOAD into fppd to move its own monotonic clock -- the
 * exported GetMonotonicTimeMS() and GetMonotonicTimeMicros() in libfpp --
 * $MONOSHIFT_DAYS days (default 14) ahead, as on a player that has been up
 * that long.  libfpp calls these through its PLT, so the preload replaces
 * them for libfpp's own callers too.  fppd uses them for differences and
 * relative deadlines (timerfds are armed relative), so a constant shift
 * changes nothing else; the kernel's CLOCK_MONOTONIC is left alone.
 *
 * The C++ names are spelled out mangled (they take no arguments, so the
 * mangling is just the name).  The first time a caller inside FPP's WLED
 * code (or its millis()/micros() wrappers) is seen, its symbol is appended to $MONOSHIFT_LOG, so a test can
 * show the shifted clock reached the code under test.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static long long shift_ms(void) {
    static long long shift = -1;
    if (shift < 0) {
        const char* d = getenv("MONOSHIFT_DAYS");
        shift = (d && *d ? atoll(d) : 14) * 86400000LL;
    }
    return shift;
}

static void note_caller(void* ra) {
    static int noted;
    if (noted) {
        return;
    }
    Dl_info info;
    // Optimized, WLED's millis()/micros() (wled.h) are inlined into the
    // effects; at -O0 (the coverage build) they are functions of their own,
    // and are the callers seen here. Only the WLED port defines them.
    if (dladdr(ra, &info) && info.dli_sname &&
        (strstr(info.dli_sname, "WS2812FX") || strstr(info.dli_sname, "mode_") ||
         !strcmp(info.dli_sname, "_Z6millisv") || !strcmp(info.dli_sname, "_Z10GET_MILLISv") ||
         !strcmp(info.dli_sname, "_Z6microsv"))) {
        noted = 1;
        const char* log = getenv("MONOSHIFT_LOG");
        int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT, 0644) : -1;
        if (fd >= 0) {
            (void)!write(fd, info.dli_sname, strlen(info.dli_sname));
            (void)!write(fd, "\n", 1);
            close(fd);
        }
    }
}

long long _Z18GetMonotonicTimeMSv(void) {
    note_caller(__builtin_return_address(0));
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000 + shift_ms();
}

long long _Z22GetMonotonicTimeMicrosv(void) {
    note_caller(__builtin_return_address(0));
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000LL + ts.tv_nsec / 1000 + shift_ms() * 1000;
}
