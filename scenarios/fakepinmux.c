/* fakepinmux.so: LD_PRELOAD into the tree's own pinctrl on an AM335x
 * BeagleBone, so it can be run without re-muxing the device's pads.
 *
 * /dev/am335xpm (the FPP kernel's pinmux driver: fd offset 0 is the control
 * module's conf register for ball offset 0x800) is opened as the file
 * $FAKEPINMUX_FILE instead, so pinctrl's pread()/pwrite() of the pad
 * registers land there and a scenario reads them back.  With FAKEPINMUX_FILE
 * unset or empty, /dev/am335xpm does not exist (ENOENT), as on a kernel
 * without the driver.  /dev/mem is left alone: under run-local.sh it is
 * /dev/null, which cannot be mapped.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#define REAL(name) \
    static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

static int fake(const char* path, int* fd) {
    if (!path || strcmp(path, "/dev/am335xpm") != 0) return 0;
    const char* f = getenv("FAKEPINMUX_FILE");
    if (!f || !*f) {
        errno = ENOENT;
        *fd = -1;
        return 1;
    }
    REAL(open);
    *fd = real_open(f, O_RDWR);
    return 1;
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
    int fd;
    if (fake(path, &fd)) return fd;
    return real_open(path, flags, mode);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    int fd;
    if (fake(path, &fd)) return fd;
    return real_open64(path, flags, mode);
}

int __open_2(const char* path, int flags) {
    REAL(__open_2);
    int fd;
    if (fake(path, &fd)) return fd;
    return real___open_2(path, flags);
}

int __open64_2(const char* path, int flags) {
    REAL(__open64_2);
    int fd;
    if (fake(path, &fd)) return fd;
    return real___open64_2(path, flags);
}
