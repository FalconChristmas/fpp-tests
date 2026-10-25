/* fakespi.so: LD_PRELOAD into fppd to give its SPI outputs (GenericSPI,
 * SPIws2801, MAX7219Matrix, ...) a spidev that records what they send.
 *
 * Opening any /dev/spidevB.C gives a descriptor on /dev/null that this
 * answers for: the setup ioctls (mode, bits per word, speed) succeed, and
 * each SPI_IOC_MESSAGE(n) transfer is appended to $FAKESPI_OUT, one line
 * each:
 *     <monotonic ms> <device> <len> <rx> <tx bytes, hex, at most 512>
 * where <rx> is "none" for a send-only transfer (rx_buf 0), "tx" when the
 * receive buffer is the transmit buffer, and "own" for a buffer of its own.
 * Like the kernel's spidev, a transfer with a receive buffer then fills it
 * with what came in on MISO: $FAKESPI_MISO (a byte, default 0x00, an
 * unconnected MISO).
 *
 * Both ioctl spellings are caught: a 32-bit build with 64-bit time_t calls
 * __ioctl_time64.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/spi/spidev.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define MAXFD 1024

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static char devOf[MAXFD][32];

static int spiPath(const char* path) {
    return path && strncmp(path, "/dev/spidev", 11) == 0;
}
static int ours(int fd) {
    return fd >= 0 && fd < MAXFD && devOf[fd][0];
}

#define OPEN_WRAPPER(name)                                              \
    int name(const char* path, int flags, ...) {                        \
        static int (*real)(const char*, int, ...);                      \
        if (!real)                                                      \
            real = dlsym(RTLD_NEXT, #name);                             \
        int mode = 0;                                                   \
        if (flags & (O_CREAT | O_TMPFILE)) {                            \
            va_list ap;                                                 \
            va_start(ap, flags);                                        \
            mode = va_arg(ap, int);                                     \
            va_end(ap);                                                 \
        }                                                               \
        if (!spiPath(path)) {                                           \
            return real(path, flags, mode);                             \
        }                                                               \
        int fd = real("/dev/null", O_RDWR | (flags & O_CLOEXEC));       \
        if (fd >= 0 && fd < MAXFD) {                                    \
            pthread_mutex_lock(&lock);                                  \
            snprintf(devOf[fd], sizeof(devOf[fd]), "%s", path + 5);     \
            pthread_mutex_unlock(&lock);                                \
        }                                                               \
        return fd;                                                      \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

int close(int fd) {
    static int (*real)(int);
    if (!real)
        real = dlsym(RTLD_NEXT, "close");
    if (fd >= 0 && fd < MAXFD) {
        devOf[fd][0] = 0;
    }
    return real(fd);
}

static void logTransfer(int fd, const struct spi_ioc_transfer* t) {
    const char* out = getenv("FAKESPI_OUT");
    if (!out) {
        return;
    }
    static int (*realOpen)(const char*, int, ...);
    static ssize_t (*realWrite)(int, const void*, size_t);
    static int (*realClose)(int);
    if (!realOpen) {
        realOpen = dlsym(RTLD_NEXT, "open");
        realWrite = dlsym(RTLD_NEXT, "write");
        realClose = dlsym(RTLD_NEXT, "close");
    }
    static char line[128 + 2 * 512];
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    const char* rx = !t->rx_buf ? "none" : (t->rx_buf == t->tx_buf ? "tx" : "own");
    int len = snprintf(line, 128, "%lld %s %u %s ", (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000,
                       devOf[fd], t->len, rx);
    const unsigned char* b = (const unsigned char*)(unsigned long)t->tx_buf;
    for (unsigned i = 0; b && i < t->len && i < 512; i++) {
        len += snprintf(line + len, 3, "%02x", b[i]);
    }
    line[len++] = '\n';
    int f = realOpen(out, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (f >= 0) {
        realWrite(f, line, len);
        realClose(f);
    }
}

static int spiIoctl(int fd, unsigned long req, void* arg) {
    if (_IOC_TYPE(req) != SPI_IOC_MAGIC) {
        errno = ENOTTY;
        return -1;
    }
    if (_IOC_NR(req) == 0 && _IOC_DIR(req) == _IOC_WRITE) {
        /* SPI_IOC_MESSAGE(n): n transfers */
        int n = _IOC_SIZE(req) / sizeof(struct spi_ioc_transfer);
        const struct spi_ioc_transfer* t = arg;
        const char* m = getenv("FAKESPI_MISO");
        int miso = m ? (int)strtol(m, NULL, 0) : 0;
        int total = 0;
        pthread_mutex_lock(&lock);
        for (int i = 0; i < n; i++) {
            logTransfer(fd, &t[i]);
            if (t[i].rx_buf) {
                memset((void*)(unsigned long)t[i].rx_buf, miso, t[i].len);
            }
            total += t[i].len;
        }
        pthread_mutex_unlock(&lock);
        return total;
    }
    return 0; /* mode, bits per word, speed: set or read, all fine */
}

#define IOCTL_WRAPPER(name)                                            \
    int name(int fd, unsigned long req, ...) {                         \
        static int (*real)(int, unsigned long, ...);                   \
        if (!real)                                                     \
            real = dlsym(RTLD_NEXT, #name);                            \
        va_list ap;                                                    \
        va_start(ap, req);                                             \
        void* arg = va_arg(ap, void*);                                 \
        va_end(ap);                                                    \
        if (ours(fd)) {                                                \
            return spiIoctl(fd, req, arg);                             \
        }                                                              \
        return real(fd, req, arg);                                     \
    }
IOCTL_WRAPPER(ioctl)
IOCTL_WRAPPER(__ioctl_time64)
