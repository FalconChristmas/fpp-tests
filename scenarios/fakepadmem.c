/* fakepadmem.so: LD_PRELOAD into the tree's own pinctrl on an AM62x board
 * (PocketBeagle2), so it can be run without re-muxing the device's pads.
 *
 * /dev/mem is opened as the file $FAKEPADMEM_FILE instead: pinctrl maps the
 * MCU and MAIN domain pad registers at their physical offsets (0x4084000 and
 * 0xf4000), so on a sparse file of that size its writes land in the file at
 * those offsets and a scenario reads them back.  /proc/device-tree/model is
 * read from $FAKEPADMEM_MODEL when that is set, so the tool takes the board
 * the scenario names whatever it runs on.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define REAL(name) \
    static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

static const char* swap(const char* path) {
    if (!path) return path;
    if (strcmp(path, "/dev/mem") == 0) {
        const char* f = getenv("FAKEPADMEM_FILE");
        if (f && *f) return f;
    } else if (strcmp(path, "/proc/device-tree/model") == 0) {
        const char* f = getenv("FAKEPADMEM_MODEL");
        if (f && *f) return f;
    }
    return path;
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
    return real_open(swap(path), flags, mode);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    return real_open64(swap(path), flags, mode);
}

int __open_2(const char* path, int flags) {
    REAL(__open_2);
    return real___open_2(swap(path), flags);
}

int __open64_2(const char* path, int flags) {
    REAL(__open64_2);
    return real___open64_2(swap(path), flags);
}

FILE* fopen(const char* path, const char* mode) {
    REAL(fopen);
    return real_fopen(swap(path), mode);
}

FILE* fopen64(const char* path, const char* mode) {
    REAL(fopen64);
    return real_fopen64(swap(path), mode);
}
