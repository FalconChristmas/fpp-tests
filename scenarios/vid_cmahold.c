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
#include <execinfo.h>
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

// A few frames up, not just the caller: under a sanitizer its runtime is
// preloaded ahead of this, and its fopen interceptor is what calls ours.
static int from_cma_check(void) {
    void* frames[8];
    int n = backtrace(frames, 8);
    for (int i = 0; i < n; i++) {
        Dl_info info = { 0 };
        if (dladdr(frames[i], &info) && info.dli_sname &&
            (strstr(info.dli_sname, "ReadCmaFreeKB") || strstr(info.dli_sname, "WaitForCmaIfLow"))) {
            return 1;
        }
    }
    return 0;
}

// The real /proc/meminfo with its CmaFree line replaced (or added), in a
// stream of its own: fppd's threads read it at once (a video's teardown and
// a consumer's start).
static FILE* short_cma(FILE* (*real)(const char*, const char*), const char* kb) {
    char text[16384];
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
    // A NULL buffer: fmemopen allocates one and frees it at fclose.
    FILE* out = fmemopen(NULL, n, "w+");
    if (out) {
        fwrite(text, 1, n, out);
        rewind(out);
    }
    return out;
}

static FILE* steer(FILE* (*real)(const char*, const char*), const char* path, const char* mode) {
    if (!path || strcmp(path, "/proc/meminfo")) {
        return real(path, mode);
    }
    const char* ms = getenv("CMAHOLD_MS");
    if (ms && atoi(ms) > 0 && from_cma_check()) {
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
    return steer(real_fopen, path, mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    }
    if (!real_fopen) {
        real_fopen = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    }
    return steer(real, path, mode);
}
