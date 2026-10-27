/* med_holdread.so: LD_PRELOAD into fppd to keep one media file's pipeline
 * from prerolling. Once $HOLDREAD_ARM exists, the first read of a file whose
 * path ends in $HOLDREAD_NAME, made on a GStreamer streaming thread (a pad
 * task: its thread name has a ':' in it, e.g. "wavparse0:sink"), creates
 * $HOLDREAD_MARK and waits until $HOLDREAD_RELEASE exists (at most 30 s).
 * fppd's own opens of the file (tags, duration) on its other threads are
 * left alone, and media opened before the arm file appears plays normally.
 * With HOLDREAD_UNTIL_NULL=<ms>, the hold also lets go once fppd sets any
 * pipeline to NULL (tears it down) that many ms or more into the hold, as a
 * stalled decoder lets go when its pipeline is flushed; teardowns of other
 * pipelines early in the hold don't count.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

static int held_fd = -1;
static int done;
static volatile long long last_null_ms;

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

static void note(int fd, const char* path) {
    const char* name = getenv("HOLDREAD_NAME");
    const char* arm = getenv("HOLDREAD_ARM");
    if (fd < 0 || done || !name || !path || !arm || access(arm, F_OK) != 0) {
        return;
    }
    size_t n = strlen(name), p = strlen(path);
    if (p >= n && strcmp(path + p - n, name) == 0) {
        held_fd = fd;
    }
}

static void hold(int fd) {
    char thread[17] = "";
    if (fd != held_fd || done) {
        return;
    }
    prctl(PR_GET_NAME, thread);
    if (!strchr(thread, ':')) {
        return;
    }
    done = 1;
    const char* mark = getenv("HOLDREAD_MARK");
    const char* release = getenv("HOLDREAD_RELEASE");
    if (mark) {
        static int (*real_open)(const char*, int, ...);
        if (!real_open) {
            real_open = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, "open");
        }
        close(real_open(mark, O_CREAT | O_WRONLY, 0644));
    }
    const char* until_null = getenv("HOLDREAD_UNTIL_NULL");
    long long began = now_ms();
    long long after = until_null ? began + atoll(until_null) : -1;
    for (int i = 0; i < 600 && !(release && access(release, F_OK) == 0); i++) {
        if (until_null && last_null_ms >= after) {
            break;
        }
        usleep(50000);
    }
}

int gst_element_set_state(void* element, int state) {
    static int (*real)(void*, int);
    if (!real) {
        real = (int (*)(void*, int))dlsym(RTLD_NEXT, "gst_element_set_state");
    }
    if (state == 1) {  /* GST_STATE_NULL */
        last_null_ms = now_ms();
    }
    return real(element, state);
}

#define OPENER(fn, ...)                                                   \
    static int (*real)(__VA_ARGS__, ...);                                 \
    if (!real) {                                                          \
        real = (int (*)(__VA_ARGS__, ...))dlsym(RTLD_NEXT, fn);           \
    }                                                                     \
    mode_t mode = 0;                                                      \
    if (flags & (O_CREAT | O_TMPFILE)) {                                  \
        va_list ap;                                                       \
        va_start(ap, flags);                                              \
        mode = va_arg(ap, mode_t);                                        \
        va_end(ap);                                                       \
    }

int open(const char* path, int flags, ...) {
    OPENER("open", const char*, int)
    int fd = real(path, flags, mode);
    note(fd, path);
    return fd;
}

int open64(const char* path, int flags, ...) {
    OPENER("open64", const char*, int)
    int fd = real(path, flags, mode);
    note(fd, path);
    return fd;
}

int openat(int dir, const char* path, int flags, ...) {
    OPENER("openat", int, const char*, int)
    int fd = real(dir, path, flags, mode);
    note(fd, path);
    return fd;
}

int openat64(int dir, const char* path, int flags, ...) {
    OPENER("openat64", int, const char*, int)
    int fd = real(dir, path, flags, mode);
    note(fd, path);
    return fd;
}

ssize_t read(int fd, void* buf, size_t count) {
    static ssize_t (*real)(int, void*, size_t);
    if (!real) {
        real = (ssize_t (*)(int, void*, size_t))dlsym(RTLD_NEXT, "read");
    }
    hold(fd);
    return real(fd, buf, count);
}

ssize_t pread(int fd, void* buf, size_t count, off_t off) {
    static ssize_t (*real)(int, void*, size_t, off_t);
    if (!real) {
        real = (ssize_t (*)(int, void*, size_t, off_t))dlsym(RTLD_NEXT, "pread");
    }
    hold(fd);
    return real(fd, buf, count, off);
}

ssize_t pread64(int fd, void* buf, size_t count, off_t off) {
    static ssize_t (*real)(int, void*, size_t, off_t);
    if (!real) {
        real = (ssize_t (*)(int, void*, size_t, off_t))dlsym(RTLD_NEXT, "pread64");
    }
    hold(fd);
    return real(fd, buf, count, off);
}
