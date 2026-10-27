/* Gives every interface a PTP hardware clock: ETHTOOL_GET_TS_INFO answers
 * phc_index 0, /dev/ptp0 opens (as /dev/null), and clock_gettime() on the
 * dynamic clock of that fd reads CLOCK_REALTIME plus FAKEPHC_OFFSET_S
 * seconds (default 100) -- a PHC nothing disciplines, on its own timeline.
 * Every other clock and file is untouched. Calls before the constructor
 * (ASan's own start-up among them) go straight to the kernel, without
 * dlsym. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <linux/ethtool.h>
#include <linux/sockios.h>
#include <net/if.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static int phc_fd = -1;
static long offset_s = 100;
static int (*real_ioctl)(int, unsigned long, ...);
static int (*real_open)(const char*, int, ...);
static int (*real_open64)(const char*, int, ...);
static int (*real_clock_gettime)(clockid_t, struct timespec*);

__attribute__((constructor)) static void init(void) {
    const char* off = getenv("FAKEPHC_OFFSET_S");
    if (off) offset_s = atol(off);
    real_ioctl = dlsym(RTLD_NEXT, "ioctl");
    real_open = dlsym(RTLD_NEXT, "open");
    real_open64 = dlsym(RTLD_NEXT, "open64");
    real_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
}

int ioctl(int fd, unsigned long req, ...) {
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (req == SIOCETHTOOL && arg) {
        struct ifreq* ifr = arg;
        struct ethtool_ts_info* tsi = (struct ethtool_ts_info*)ifr->ifr_data;
        if (tsi && tsi->cmd == ETHTOOL_GET_TS_INFO) {
            memset(tsi, 0, sizeof(*tsi));
            tsi->cmd = ETHTOOL_GET_TS_INFO;
            tsi->phc_index = 0;
            return 0;
        }
    }
    return real_ioctl ? real_ioctl(fd, req, arg) : syscall(SYS_ioctl, fd, req, arg);
}

static int open_common(int (*real)(const char*, int, ...), const char* path, int flags, mode_t mode) {
    if (path && strcmp(path, "/dev/ptp0") == 0) {
        int fd = (int)syscall(SYS_openat, AT_FDCWD, "/dev/null", O_RDONLY | O_CLOEXEC);
        phc_fd = fd;
        return fd;
    }
    return real ? real(path, flags, mode) : (int)syscall(SYS_openat, AT_FDCWD, path, flags, mode);
}

int open(const char* path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, int);
        va_end(ap);
    }
    return open_common(real_open, path, flags, mode);
}

int open64(const char* path, int flags, ...) {
    mode_t mode = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        mode = va_arg(ap, int);
        va_end(ap);
    }
    return open_common(real_open64, path, flags, mode);
}

int clock_gettime(clockid_t id, struct timespec* ts) {
    if (phc_fd >= 0 && id == (clockid_t)((((unsigned int)~phc_fd) << 3) | 3)) {
        int r = (int)syscall(SYS_clock_gettime, CLOCK_REALTIME, ts);
        ts->tv_sec += offset_s;
        return r;
    }
    return real_clock_gettime ? real_clock_gettime(id, ts) : (int)syscall(SYS_clock_gettime, id, ts);
}
