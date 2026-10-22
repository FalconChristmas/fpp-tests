/* failplane.so: LD_PRELOAD into fppd to log every drmModeSetPlane() and make
 * one of kmssink's fail, as a display that goes away under it does: kmssink
 * posts an ERROR and the video output manager restarts its consumer.
 *
 * A call is kmssink's when it comes from a GStreamer streaming thread, whose
 * name has ":src" or ":sink" in it (fppd's own threads are "fppd" and
 * "FPP-..."). After FAILPLANE_SKIP (default 30) of kmssink's calls go
 * through, the next FAILPLANE_COUNT (default 1) fail with EIO. Every call is
 * logged to FAILPLANE_LOG as "<k|f> <fd> <crtc> <monotonic s> <rc>": k for
 * kmssink's, f for fppd's own framebuffer outputs.
 *
 * FAILPLANE_STOP_DELAY_MS holds up the dead pipeline's teardown: the first
 * drmModeRmFB() after the failed updates -- kmssink dropping its cached
 * framebuffers as it stops -- sleeps that long first, so the old consumer's
 * lease is still held when its restart asks for the connector. Logged as
 * "c <fd> <fb id> <monotonic s> <ms slept>".
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

static int seen;

static void log_call(char what, int fd, uint32_t crtc_id, int rc) {
    const char* path = getenv("FAILPLANE_LOG");
    if (path) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        FILE* f = fopen(path, "a");
        if (f) {
            fprintf(f, "%c %d %u %.6f %d\n", what, fd, crtc_id, ts.tv_sec + ts.tv_nsec / 1e9, rc);
            fclose(f);
        }
    }
}

int drmModeSetPlane(int fd, uint32_t plane_id, uint32_t crtc_id, uint32_t fb_id, uint32_t flags,
                    int32_t crtc_x, int32_t crtc_y, uint32_t crtc_w, uint32_t crtc_h,
                    uint32_t src_x, uint32_t src_y, uint32_t src_w, uint32_t src_h) {
    static int (*real)(int, uint32_t, uint32_t, uint32_t, uint32_t, int32_t, int32_t, uint32_t,
                       uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
    if (!real) {
        real = dlsym(RTLD_NEXT, "drmModeSetPlane");
    }
    char name[17] = "";
    prctl(PR_GET_NAME, name);
    int kms = strstr(name, ":src") || strstr(name, ":sink");
    int rc;
    if (kms) {
        const char* skip = getenv("FAILPLANE_SKIP");
        const char* count = getenv("FAILPLANE_COUNT");
        int n = __atomic_fetch_add(&seen, 1, __ATOMIC_SEQ_CST) - (skip ? atoi(skip) : 30);
        if (n >= 0 && n < (count ? atoi(count) : 1)) {
            errno = EIO;
            rc = -EIO;
            goto log;
        }
    }
    rc = real(fd, plane_id, crtc_id, fb_id, flags, crtc_x, crtc_y, crtc_w, crtc_h,
              src_x, src_y, src_w, src_h);
log:
    log_call(kms ? 'k' : 'f', fd, crtc_id, rc);
    return rc;
}

int drmModeRmFB(int fd, uint32_t fb_id) {
    static int (*real)(int, uint32_t);
    static int delayed;
    if (!real) {
        real = dlsym(RTLD_NEXT, "drmModeRmFB");
    }
    const char* skip = getenv("FAILPLANE_SKIP");
    const char* count = getenv("FAILPLANE_COUNT");
    const char* delay = getenv("FAILPLANE_STOP_DELAY_MS");
    int failed = __atomic_load_n(&seen, __ATOMIC_SEQ_CST) >= (skip ? atoi(skip) : 30) + (count ? atoi(count) : 1);
    if (delay && failed && !__atomic_exchange_n(&delayed, 1, __ATOMIC_SEQ_CST)) {
        int ms = atoi(delay);
        log_call('c', fd, fb_id, ms);
        usleep(ms * 1000);
    }
    return real(fd, fb_id);
}
