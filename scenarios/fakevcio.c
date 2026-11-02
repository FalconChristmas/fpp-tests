/* fakevcio.so: LD_PRELOAD into fppd to answer the Raspberry Pi firmware's
 * "get_throttled" query on /dev/vcio, for a power supply a test controls.
 *
 * Opening /dev/vcio gives a descriptor on /dev/null whose mailbox ioctl
 * (_IOWR(100, 0, char*)) fills the property buffer's response with
 * "throttled=0x<N>\0", where <N> is the text of the file named by
 * FAKEVCIO_FILE read on every call ("0x1" is the under-voltage bit; a
 * missing file is 0x0).
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAXFD 1024
static int ours[MAXFD];

static int track(int fd, const char* path) {
    if (fd >= 0 && fd < MAXFD) {
        ours[fd] = (path && strcmp(path, "/dev/vcio") == 0);
    }
    return fd;
}

#define OPEN_WRAPPER(name)                                              \
    int name(const char* path, int flags, ...) {                        \
        static int (*real)(const char*, int, ...);                      \
        if (!real)                                                      \
            real = dlsym(RTLD_NEXT, #name);                             \
        mode_t mode = 0;                                                \
        if (flags & O_CREAT) {                                          \
            va_list ap;                                                 \
            va_start(ap, flags);                                        \
            mode = va_arg(ap, int);                                     \
            va_end(ap);                                                 \
        }                                                               \
        if (path && strcmp(path, "/dev/vcio") == 0) {                   \
            int fd = real("/dev/null", flags, mode);                    \
            return track(fd, path);                                     \
        }                                                               \
        return track(real(path, flags, mode), path);                    \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

int close(int fd) {
    static int (*real)(int);
    if (!real)
        real = dlsym(RTLD_NEXT, "close");
    if (fd >= 0 && fd < MAXFD)
        ours[fd] = 0;
    return real(fd);
}

static int answer(int fd, unsigned long req, void* arg) {
    (void)fd;
    if (req != (unsigned long)_IOWR(100, 0, char*)) {
        return 0;
    }
    int32_t* p = arg;
    const char* file = getenv("FAKEVCIO_FILE");
    char val[32] = "0x0";
    if (file) {
        FILE* f = fopen(file, "r");
        if (f) {
            if (fscanf(f, "%31s", val) != 1)
                strcpy(val, "0x0");
            fclose(f);
        }
    }
    snprintf((char*)&p[6], 64, "throttled=%s", val);
    return 0;
}

int ioctl(int fd, unsigned long req, ...) {
    static int (*real)(int, unsigned long, ...);
    if (!real)
        real = dlsym(RTLD_NEXT, "ioctl");
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (fd >= 0 && fd < MAXFD && ours[fd]) {
        return answer(fd, req, arg);
    }
    return real(fd, req, arg);
}

/* armhf with 64-bit time_t calls this instead */
int __ioctl_time64(int fd, unsigned long req, ...) {
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    return ioctl(fd, req, arg);
}
