/*
 * A fake SSD1306 OLED for fppoled, loaded with LD_PRELOAD (see oled.py).
 *
 * fppoled draws its pages into a 128x64 buffer and sends it to the panel
 * over /dev/i2c-N at address 0x3C: control byte 0x00 and a command, or 0x40
 * and a run of GDDRAM bytes. Under run-local.sh every /dev/i2c-N is
 * /dev/null, so opening one works but nothing answers. This answers for
 * fds open on a /dev/i2c-* path: I2C_SLAVE always succeeds, and writes to
 * 0x3C are decoded the way the controller would -- column and page window,
 * horizontal addressing -- into a copy of the panel's memory. Every other
 * address, and every read, fails with ENXIO, like a bus with nothing else
 * on it.
 *
 *   FAKESSD1306_OUT   the file each frame is appended to, one line each:
 *                       F <monotonic ms> <1024 bytes, hex>   a whole frame
 *                       C <monotonic ms> <command, hex>     display on/off
 *                     A frame is the 1024th byte written since the window
 *                     was last set (fppoled sends the whole buffer each
 *                     time). Byte p*128+x is page p (rows 8p..8p+7, bit 0
 *                     on top) of column x, as on the panel.
 */
/* open() and open64() are both defined below: a 32-bit build with 64-bit
 * file offsets would make them one symbol. */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define I2C_SLAVE 0x0703
#define I2C_SLAVE_FORCE 0x0706
#define OLED_ADDR 0x3C
#define MAXFD 1024

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int addrOf[MAXFD]; /* 0: not ours; else slave address + 1 (1: none set) */

static unsigned char gddram[1024];
static int colStart = 0, colEnd = 127, pageStart = 0, pageEnd = 7;
static int col = 0, page = 0, sinceWindow = 0;
static int pendingCmd = -1, pendingArgs = 0, argIdx = 0;
static unsigned char args[8];

static long long nowMs(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void emit(const char* line) {
    const char* out = getenv("FAKESSD1306_OUT");
    if (!out) {
        return;
    }
    static int (*realOpen)(const char*, int, ...);
    static ssize_t (*realWrite)(int, const void*, size_t);
    if (!realOpen) {
        realOpen = dlsym(RTLD_NEXT, "open");
        realWrite = dlsym(RTLD_NEXT, "write");
    }
    int fd = realOpen(out, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        realWrite(fd, line, strlen(line));
        close(fd);
    }
}

static void emitFrame(void) {
    static char line[32 + 2048 + 2];
    int n = snprintf(line, 32, "F %lld ", nowMs());
    for (int i = 0; i < 1024; i++) {
        n += sprintf(line + n, "%02x", gddram[i]);
    }
    line[n++] = '\n';
    line[n] = 0;
    emit(line);
}

static int argCount(unsigned char c) {
    switch (c) {
    case 0x20: case 0x81: case 0x8D: case 0xA8: case 0xD3: case 0xD5:
    case 0xD9: case 0xDA: case 0xDB:
        return 1;
    case 0x21: case 0x22: case 0xA3:
        return 2;
    case 0x29: case 0x2A:
        return 5;
    case 0x26: case 0x27:
        return 6;
    }
    return 0;
}

static void command(unsigned char c) {
    if (pendingCmd >= 0) {
        args[argIdx++] = c;
        if (argIdx < pendingArgs) {
            return;
        }
        if (pendingCmd == 0x21) {
            colStart = col = args[0] & 0x7F;
            colEnd = args[1] & 0x7F;
            sinceWindow = 0;
        } else if (pendingCmd == 0x22) {
            pageStart = page = args[0] & 0x07;
            pageEnd = args[1] & 0x07;
            sinceWindow = 0;
        }
        pendingCmd = -1;
        return;
    }
    if (c == 0xAE || c == 0xAF) {
        char line[64];
        snprintf(line, sizeof(line), "C %lld %02x\n", nowMs(), c);
        emit(line);
    }
    int n = argCount(c);
    if (n) {
        pendingCmd = c;
        pendingArgs = n;
        argIdx = 0;
    }
}

static void data(unsigned char b) {
    gddram[page * 128 + col] = b;
    if (++col > colEnd) {
        col = colStart;
        if (++page > pageEnd) {
            page = pageStart;
        }
    }
    if (++sinceWindow == 1024) {
        emitFrame();
        sinceWindow = 0;
    }
}

static void track(int fd, const char* path) {
    if (fd >= 0 && fd < MAXFD) {
        pthread_mutex_lock(&lock);
        addrOf[fd] = (path && strncmp(path, "/dev/i2c-", 9) == 0) ? 1 : 0;
        pthread_mutex_unlock(&lock);
    }
}

static int ours(int fd) {
    return fd >= 0 && fd < MAXFD && addrOf[fd];
}

#define OPEN_WRAPPER(name)                                              \
    int name(const char* path, int flags, ...) {                        \
        static int (*real)(const char*, int, ...);                      \
        if (!real)                                                      \
            real = dlsym(RTLD_NEXT, #name);                             \
        mode_t mode = 0;                                                \
        if (flags & (O_CREAT | O_TMPFILE)) {                            \
            va_list ap;                                                 \
            va_start(ap, flags);                                        \
            mode = va_arg(ap, mode_t);                                  \
            va_end(ap);                                                 \
        }                                                               \
        int fd = real(path, flags, mode);                               \
        track(fd, path);                                                \
        return fd;                                                      \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

#define OPENAT_WRAPPER(name)                                            \
    int name(int dir, const char* path, int flags, ...) {               \
        static int (*real)(int, const char*, int, ...);                 \
        if (!real)                                                      \
            real = dlsym(RTLD_NEXT, #name);                             \
        mode_t mode = 0;                                                \
        if (flags & (O_CREAT | O_TMPFILE)) {                            \
            va_list ap;                                                 \
            va_start(ap, flags);                                        \
            mode = va_arg(ap, mode_t);                                  \
            va_end(ap);                                                 \
        }                                                               \
        int fd = real(dir, path, flags, mode);                          \
        track(fd, path);                                                \
        return fd;                                                      \
    }
OPENAT_WRAPPER(openat)
OPENAT_WRAPPER(openat64)

int close(int fd) {
    static int (*real)(int);
    if (!real)
        real = dlsym(RTLD_NEXT, "close");
    if (fd >= 0 && fd < MAXFD) {
        addrOf[fd] = 0;
    }
    return real(fd);
}

int ioctl(int fd, unsigned long req, ...) {
    static int (*real)(int, unsigned long, ...);
    if (!real)
        real = dlsym(RTLD_NEXT, "ioctl");
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (!ours(fd)) {
        return real(fd, req, arg);
    }
    if (req == I2C_SLAVE || req == I2C_SLAVE_FORCE) {
        addrOf[fd] = (int)(long)arg + 1;
        return 0;
    }
    errno = ENXIO;
    return -1;
}

/* A 32-bit build with 64-bit time_t (armhf since Debian trixie) calls this
 * instead of ioctl(). */
int __ioctl_time64(int fd, unsigned long req, ...) {
    static int (*real)(int, unsigned long, ...);
    if (!real)
        real = dlsym(RTLD_NEXT, "__ioctl_time64");
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (!ours(fd)) {
        return real(fd, req, arg);
    }
    return ioctl(fd, req, arg);
}

ssize_t write(int fd, const void* buf, size_t len) {
    static ssize_t (*real)(int, const void*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "write");
    if (!ours(fd)) {
        return real(fd, buf, len);
    }
    if (addrOf[fd] - 1 != OLED_ADDR || len < 1) {
        errno = ENXIO;
        return -1;
    }
    const unsigned char* b = buf;
    pthread_mutex_lock(&lock);
    /* Co = 0 throughout, as fppoled sends it: one control byte, then the
     * rest of the message is commands (0x00) or data (0x40). */
    for (size_t i = 1; i < len; i++) {
        if (b[0] & 0x40) {
            data(b[i]);
        } else {
            command(b[i]);
        }
    }
    pthread_mutex_unlock(&lock);
    return len;
}

ssize_t read(int fd, void* buf, size_t len) {
    static ssize_t (*real)(int, void*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "read");
    if (!ours(fd)) {
        return real(fd, buf, len);
    }
    errno = ENXIO;
    return -1;
}
