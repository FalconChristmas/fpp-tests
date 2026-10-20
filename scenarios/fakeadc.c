/* fakeadc.so: LD_PRELOAD into fppd to give it the analog inputs a cape's
 * current sensing reads, with no hardware: an IIO ADC's sysfs and device
 * files, and an ADS7828 on an I2C bus.
 *
 * FAKEADC_MAP="<from>=<to>[;<from>=<to>...]": a path that is <from> or
 * starts with <from>/ is opened (and stat()ed) as <to> plus the rest, as in
 * fakesys.c -- but split on ';', since IIO's names ("iio:device0") have
 * colons in them.  That serves /sys/bus/iio/devices/iio:device0 and
 * /dev/iio:device0 from the media directory.
 *
 * FAKEADC_I2C_BUS=N: opening /dev/i2c-N gives a descriptor on /dev/null
 * whose I2C ioctls this answers: I2C_SLAVE and I2C_FUNCS succeed, an SMBus
 * byte read (the probe) reads 0, and an I2C block read fills the block with
 * 0x01 0x23 pairs -- an ADS7828 sample of 0x123 -- for the first
 * $FAKEADC_GOOD_READS block reads (default 0), then fails with EIO every
 * time, as a chip that stopped answering does.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_MAPS 8
#define MAX_FDS 16

static struct {
    char from[256];
    char to[256];
} maps[MAX_MAPS];
static int nmaps = -1;

static int busFds[MAX_FDS];
static int nBusFds;
static int goodReads = -1;

static void load_maps(void) {
    nmaps = 0;
    const char* env = getenv("FAKEADC_MAP");
    if (!env) return;
    char buf[2048];
    snprintf(buf, sizeof(buf), "%s", env);
    char* save = NULL;
    for (char* tok = strtok_r(buf, ";", &save); tok && nmaps < MAX_MAPS; tok = strtok_r(NULL, ";", &save)) {
        char* eq = strchr(tok, '=');
        if (!eq) continue;
        *eq = 0;
        snprintf(maps[nmaps].from, sizeof(maps[nmaps].from), "%s", tok);
        snprintf(maps[nmaps].to, sizeof(maps[nmaps].to), "%s", eq + 1);
        nmaps++;
    }
}

static const char* map(const char* path, char* out, size_t len) {
    if (nmaps < 0) load_maps();
    if (!path) return path;
    for (int i = 0; i < nmaps; i++) {
        size_t n = strlen(maps[i].from);
        if (strncmp(path, maps[i].from, n) == 0 && (path[n] == 0 || path[n] == '/')) {
            snprintf(out, len, "%s%s", maps[i].to, path + n);
            return out;
        }
    }
    return path;
}

static int isBus(const char* path) {
    const char* bus = getenv("FAKEADC_I2C_BUS");
    char want[64];
    if (!bus || !path) return 0;
    snprintf(want, sizeof(want), "/dev/i2c-%s", bus);
    return strcmp(path, want) == 0;
}

static int isBusFd(int fd) {
    for (int i = 0; i < nBusFds; i++) {
        if (busFds[i] == fd) return 1;
    }
    return 0;
}

#define REAL(name) \
    static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

static int openBus(void) {
    REAL(open);
    int fd = real_open("/dev/null", O_RDWR);
    if (fd >= 0 && nBusFds < MAX_FDS) {
        busFds[nBusFds++] = fd;
    }
    return fd;
}

int stat(const char* path, struct stat* st) {
    REAL(stat);
    char buf[512];
    return real_stat(map(path, buf, sizeof(buf)), st);
}

int lstat(const char* path, struct stat* st) {
    REAL(lstat);
    char buf[512];
    return real_lstat(map(path, buf, sizeof(buf)), st);
}

int stat64(const char* path, struct stat64* st) {
    REAL(stat64);
    char buf[512];
    return real_stat64(map(path, buf, sizeof(buf)), st);
}

int lstat64(const char* path, struct stat64* st) {
    REAL(lstat64);
    char buf[512];
    return real_lstat64(map(path, buf, sizeof(buf)), st);
}

int access(const char* path, int mode) {
    REAL(access);
    char buf[512];
    return real_access(map(path, buf, sizeof(buf)), mode);
}

static mode_t mode_arg(int flags, va_list ap) {
    return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(ap, int) : 0;
}

int open(const char* path, int flags, ...) {
    REAL(open);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    if (isBus(path)) return openBus();
    char buf[512];
    return real_open(map(path, buf, sizeof(buf)), flags, mode);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    if (isBus(path)) return openBus();
    char buf[512];
    return real_open64(map(path, buf, sizeof(buf)), flags, mode);
}

int openat(int dirfd, const char* path, int flags, ...) {
    REAL(openat);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    if (isBus(path)) return openBus();
    char buf[512];
    return real_openat(dirfd, map(path, buf, sizeof(buf)), flags, mode);
}

FILE* fopen(const char* path, const char* how) {
    REAL(fopen);
    char buf[512];
    return real_fopen(map(path, buf, sizeof(buf)), how);
}

FILE* fopen64(const char* path, const char* how) {
    REAL(fopen64);
    char buf[512];
    return real_fopen64(map(path, buf, sizeof(buf)), how);
}

int close(int fd) {
    REAL(close);
    for (int i = 0; i < nBusFds; i++) {
        if (busFds[i] == fd) {
            busFds[i] = busFds[--nBusFds];
            break;
        }
    }
    return real_close(fd);
}

static int smbus(struct i2c_smbus_ioctl_data* d) {
    if (d->read_write != I2C_SMBUS_READ) {
        return 0;
    }
    if (d->size == I2C_SMBUS_BYTE || d->size == I2C_SMBUS_BYTE_DATA) {
        if (d->data) d->data->byte = 0;
        return 0;
    }
    if (d->size == I2C_SMBUS_I2C_BLOCK_DATA && d->data) {
        if (goodReads < 0) {
            const char* g = getenv("FAKEADC_GOOD_READS");
            goodReads = g ? atoi(g) : 0;
        }
        if (goodReads == 0) {
            errno = EIO;
            return -1;
        }
        goodReads--;
        int n = d->data->block[0];
        if (n > I2C_SMBUS_BLOCK_MAX) n = I2C_SMBUS_BLOCK_MAX;
        for (int i = 0; i < n; i++) {
            d->data->block[i + 1] = (i & 1) ? 0x23 : 0x01;
        }
        return 0;
    }
    errno = EIO;
    return -1;
}

int ioctl(int fd, unsigned long req, ...) {
    REAL(ioctl);
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (!isBusFd(fd)) {
        return real_ioctl(fd, req, arg);
    }
    switch (req) {
    case I2C_SLAVE:
    case I2C_SLAVE_FORCE:
        return 0;
    case I2C_FUNCS:
        if (arg) *(unsigned long*)arg = ~0UL;
        return 0;
    case I2C_SMBUS:
        return smbus((struct i2c_smbus_ioctl_data*)arg);
    }
    errno = ENOTTY;
    return -1;
}
