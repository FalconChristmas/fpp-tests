/* vid_cmahold.so: LD_PRELOAD into fppd to steer the video output manager's
 * CMA check.
 *
 *   CMAHOLD_FREE_KB  every read of /proc/meminfo sees "CmaFree: <n> kB" (in
 *                    place of the real line, or added where there is none,
 *                    as in a container), so CMA reads as short.
 *   CMAHOLD_MS       fopen("/proc/meminfo") from VideoOutputManager's
 *                    ReadCmaFreeKB() (WaitForCmaIfLow(), which
 *                    StartConsumers() runs before it takes its lock) sleeps
 *                    this long first.  Each held call appends
 *                    "hold <monotonic s>" and then "done <monotonic s>" to
 *                    CMAHOLD_LOG, if set.
 *
 * Every other fopen (or fopen64) goes straight through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static FILE* (*real_fopen)(const char*, const char*);

static void note(const char* what) {
    const char* path = getenv("CMAHOLD_LOG");
    if (!path) {
        return;
    }
    FILE* f = real_fopen(path, "a");
    if (!f) {
        return;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    fprintf(f, "%s %.3f\n", what, ts.tv_sec + ts.tv_nsec / 1e9);
    fclose(f);
}

static int from_cma_check(void* caller) {
    Dl_info info;
    return dladdr(caller, &info) && info.dli_sname &&
           (strstr(info.dli_sname, "ReadCmaFreeKB") || strstr(info.dli_sname, "WaitForCmaIfLow"));
}

// The real /proc/meminfo with its CmaFree line replaced (or added).
static FILE* short_cma(FILE* (*real)(const char*, const char*), const char* kb) {
    static char text[16384];
    size_t n = 0;
    FILE* f = real("/proc/meminfo", "r");
    char line[256];
    while (f && fgets(line, sizeof line, f)) {
        if (strncmp(line, "CmaFree:", 8) && n + strlen(line) < sizeof text - 64) {
            memcpy(text + n, line, strlen(line));
            n += strlen(line);
        }
    }
    if (f) {
        fclose(f);
    }
    n += snprintf(text + n, sizeof text - n, "CmaFree:        %s kB\n", kb);
    return fmemopen(text, n, "r");
}

static FILE* steer(FILE* (*real)(const char*, const char*), const char* path, const char* mode,
                   void* caller) {
    if (!path || strcmp(path, "/proc/meminfo")) {
        return real(path, mode);
    }
    const char* ms = getenv("CMAHOLD_MS");
    if (ms && atoi(ms) > 0 && from_cma_check(caller)) {
        note("hold");
        usleep(atoi(ms) * 1000);
        note("done");
    }
    const char* kb = getenv("CMAHOLD_FREE_KB");
    return kb ? short_cma(real, kb) : real(path, mode);
}

FILE* fopen(const char* path, const char* mode) {
    if (!real_fopen) {
        real_fopen = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    }
    return steer(real_fopen, path, mode, __builtin_return_address(0));
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    }
    if (!real_fopen) {
        real_fopen = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    }
    return steer(real, path, mode, __builtin_return_address(0));
}
