/*
 * A fake I2C bus for fppd's I2C channel outputs (PCA9685, MCP23017,
 * PCF8574 and the like), loaded with LD_PRELOAD (see i2cbus.py).
 *
 * Opening any /dev/i2c-N gives a descriptor on /dev/null that this answers
 * for, as a bus with chips at the addresses in FAKEI2C_DEVICES and nothing
 * anywhere else. Each chip is a 256-byte register file, zero at the start:
 *
 *   - I2C_SLAVE picks the chip (any address succeeds, as the kernel's does);
 *     I2C_FUNCS reports every function;
 *   - SMBus byte, byte-data, word-data and I2C-block transfers read and
 *     write the registers (a byte read reads the register the last
 *     transfer addressed; a byte write writes that value to it as a
 *     register-less chip -- PCF8574 -- latches it); a plain write() is
 *     a register address and data, read() reads on from the last one;
 *   - a transfer to an address with no chip fails with ENXIO.
 *
 *   FAKEI2C_DEVICES   addresses with a chip, e.g. "0x40,0x20"
 *   FAKEI2C_OUT       file every write is appended to, one line each:
 *                       <monotonic ms> <addr> <reg> <data bytes, hex>
 *                     (reg "-" for a register-less byte write)
 *   FAKEI2C_FAIL      register reads (byte-data, word, block) that fail
 *                     with EIO, "addr:reg[,addr:reg]", e.g. "0x40:0x00" --
 *                     a chip whose MODE1 read errors. A plain byte read,
 *                     which is how fpp probes for a chip, never fails.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
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
static int addrOf[MAXFD]; /* 0: not ours; else slave address + 1 */
static unsigned char regs[128][256];
static int pointer[128];
static int present[128];
static int failRead[128][256];
static int configured;

static void configure(void) {
    if (configured) {
        return;
    }
    configured = 1;
    const char* d = getenv("FAKEI2C_DEVICES");
    while (d && *d) {
        char* end;
        long a = strtol(d, &end, 0);
        if (end == d) {
            break;
        }
        if (a >= 0 && a < 128) {
            present[a] = 1;
        }
        d = *end ? end + 1 : end;
    }
    const char* f = getenv("FAKEI2C_FAIL");
    while (f && *f) {
        char* end;
        long a = strtol(f, &end, 0);
        if (end == f || *end != ':') {
            break;
        }
        long r = strtol(end + 1, &end, 0);
        if (a >= 0 && a < 128 && r >= 0 && r < 256) {
            failRead[a][r] = 1;
        }
        f = *end ? end + 1 : end;
    }
}

static void logWrite(int addr, int reg, const unsigned char* b, int n) {
    const char* out = getenv("FAKEI2C_OUT");
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
    char line[64 + 3 * 64];
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    int len = snprintf(line, 64, "%lld 0x%02x ", (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000, addr);
    len += reg < 0 ? snprintf(line + len, 8, "- ") : snprintf(line + len, 8, "0x%02x ", reg);
    for (int i = 0; i < n && i < 64; i++) {
        len += snprintf(line + len, 4, "%02x", b[i]);
    }
    line[len++] = '\n';
    int fd = realOpen(out, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        realWrite(fd, line, len);
        realClose(fd);
    }
}

static int ours(int fd) {
    return fd >= 0 && fd < MAXFD && addrOf[fd];
}

static int i2cPath(const char* path) {
    return path && strncmp(path, "/dev/i2c-", 9) == 0;
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
        if (!i2cPath(path)) {                                           \
            return real(path, flags, mode);                             \
        }                                                               \
        int fd = real("/dev/null", O_RDWR | (flags & O_CLOEXEC));       \
        if (fd >= 0 && fd < MAXFD) {                                    \
            pthread_mutex_lock(&lock);                                  \
            configure();                                                \
            addrOf[fd] = 1;                                             \
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
        addrOf[fd] = 0;
    }
    return real(fd);
}

/* One SMBus transfer to `a`; 0, or -1 with errno set. */
static int smbus(int a, struct i2c_smbus_ioctl_data* t) {
    union i2c_smbus_data* d = t->data;
    int reg = t->command;
    int rd = t->read_write == I2C_SMBUS_READ;
    switch (t->size) {
    case I2C_SMBUS_QUICK:
        return 0;
    case I2C_SMBUS_BYTE:
        if (rd) {
            /* never failed: this is also fpp's probe for the chip */
            d->byte = regs[a][pointer[a]];
        } else {
            /* register-less chips latch the byte; others take it as the
             * register to read next */
            pointer[a] = reg;
            unsigned char b = reg;
            logWrite(a, -1, &b, 1);
        }
        return 0;
    case I2C_SMBUS_BYTE_DATA:
        pointer[a] = reg;
        if (rd) {
            if (failRead[a][reg]) {
                errno = EIO;
                return -1;
            }
            d->byte = regs[a][reg];
        } else {
            regs[a][reg] = d->byte;
            logWrite(a, reg, &d->byte, 1);
        }
        return 0;
    case I2C_SMBUS_WORD_DATA:
        pointer[a] = reg;
        if (rd) {
            if (failRead[a][reg] || failRead[a][(reg + 1) & 0xFF]) {
                errno = EIO;
                return -1;
            }
            d->word = regs[a][reg] | (regs[a][(reg + 1) & 0xFF] << 8);
        } else {
            unsigned char b[2] = { d->word & 0xFF, d->word >> 8 };
            regs[a][reg] = b[0];
            regs[a][(reg + 1) & 0xFF] = b[1];
            logWrite(a, reg, b, 2);
        }
        return 0;
    case I2C_SMBUS_I2C_BLOCK_DATA:
    case I2C_SMBUS_I2C_BLOCK_BROKEN:
    case I2C_SMBUS_BLOCK_DATA: {
        pointer[a] = reg;
        int n = d->block[0];
        if (n > I2C_SMBUS_BLOCK_MAX) {
            n = I2C_SMBUS_BLOCK_MAX;
        }
        if (rd) {
            for (int i = 0; i < n; i++) {
                if (failRead[a][(reg + i) & 0xFF]) {
                    errno = EIO;
                    return -1;
                }
                d->block[1 + i] = regs[a][(reg + i) & 0xFF];
            }
        } else {
            for (int i = 0; i < n; i++) {
                regs[a][(reg + i) & 0xFF] = d->block[1 + i];
            }
            logWrite(a, reg, &d->block[1], n);
        }
        return 0;
    }
    }
    errno = EINVAL;
    return -1;
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
    pthread_mutex_lock(&lock);
    int rc = 0;
    int a = addrOf[fd] - 1;
    if (req == I2C_SLAVE || req == I2C_SLAVE_FORCE) {
        long want = (long)arg;
        if (want < 0 || want > 127) {
            errno = EINVAL;
            rc = -1;
        } else {
            addrOf[fd] = want + 1;
        }
    } else if (req == I2C_FUNCS) {
        *(unsigned long*)arg = ~0UL;
    } else if (req == I2C_SMBUS) {
        if (a < 1 || !present[a]) {
            errno = ENXIO;
            rc = -1;
        } else {
            rc = smbus(a, arg);
        }
    } else {
        errno = ENOTTY;
        rc = -1;
    }
    pthread_mutex_unlock(&lock);
    return rc;
}

ssize_t write(int fd, const void* buf, size_t len) {
    static ssize_t (*real)(int, const void*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "write");
    if (!ours(fd)) {
        return real(fd, buf, len);
    }
    pthread_mutex_lock(&lock);
    int a = addrOf[fd] - 1;
    ssize_t rc = len;
    if (a < 1 || !present[a]) {
        errno = ENXIO;
        rc = -1;
    } else if (len > 0) {
        const unsigned char* b = buf;
        int reg = b[0];
        pointer[a] = reg;
        for (size_t i = 1; i < len; i++) {
            regs[a][(reg + i - 1) & 0xFF] = b[i];
        }
        logWrite(a, reg, b + 1, (int)len - 1);
    }
    pthread_mutex_unlock(&lock);
    return rc;
}

ssize_t read(int fd, void* buf, size_t len) {
    static ssize_t (*real)(int, void*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "read");
    if (!ours(fd)) {
        return real(fd, buf, len);
    }
    pthread_mutex_lock(&lock);
    int a = addrOf[fd] - 1;
    ssize_t rc = len;
    if (a < 1 || !present[a]) {
        errno = ENXIO;
        rc = -1;
    } else {
        unsigned char* b = buf;
        for (size_t i = 0; i < len; i++) {
            b[i] = regs[a][(pointer[a] + i) & 0xFF];
        }
    }
    pthread_mutex_unlock(&lock);
    return rc;
}
