/* dumbbufs.so: LD_PRELOAD ahead of fakedrm.so to record the dumb buffers fppd
 * creates and destroys on the card, so a scenario can tell whether a
 * framebuffer output that went away gave its buffers back.
 *
 *   DUMBBUFS_LOG   lines "create <handle>" and "destroy <handle>", in order
 *
 * Every call is passed on (to fakedrm.c's drmIoctl, which answers for the
 * fake card), so the card behaves as it does without this.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <xf86drm.h>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;

static void record(const char* what, unsigned handle) {
    const char* path = getenv("DUMBBUFS_LOG");
    if (!path) {
        return;
    }
    pthread_mutex_lock(&mu);
    FILE* f = fopen(path, "a");
    if (f) {
        fprintf(f, "%s %u\n", what, handle);
        fclose(f);
    }
    pthread_mutex_unlock(&mu);
}

int drmIoctl(int fd, unsigned long request, void* arg) {
    static int (*real)(int, unsigned long, void*);
    if (!real) {
        real = (int (*)(int, unsigned long, void*))dlsym(RTLD_NEXT, "drmIoctl");
    }
    if (request == DRM_IOCTL_MODE_DESTROY_DUMB) {
        record("destroy", ((struct drm_mode_destroy_dumb*)arg)->handle);
    }
    int ret = real(fd, request, arg);
    if (request == DRM_IOCTL_MODE_CREATE_DUMB && ret == 0) {
        record("create", ((struct drm_mode_create_dumb*)arg)->handle);
    }
    return ret;
}
