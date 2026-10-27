/* directstorage.so: LD_PRELOAD into a process to give one file storage that
 * disagrees with its page cache, as a bit flipped in RAM leaves a mapped
 * library: an ordinary read sees the cached bytes, an O_DIRECT read sees
 * what the disk holds.  An open of $DIRECTSTORAGE_PATH with O_DIRECT opens
 * $DIRECTSTORAGE_FROM instead (without O_DIRECT, so any filesystem will do);
 * every other open is untouched.  Each redirected open appends a line to
 * $DIRECTSTORAGE_LOG, if set.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char* redirect(const char* path, int* flags) {
    const char* want = getenv("DIRECTSTORAGE_PATH");
    const char* from = getenv("DIRECTSTORAGE_FROM");
    if (!want || !from || !path || !(*flags & O_DIRECT) || strcmp(path, want) != 0)
        return path;
    *flags &= ~O_DIRECT;
    const char* log = getenv("DIRECTSTORAGE_LOG");
    FILE* f = log ? fopen(log, "a") : NULL;
    if (f) {
        fprintf(f, "%s\n", path);
        fclose(f);
    }
    return from;
}

#define WRAP_OPEN(name)                                                       \
    int name(const char* path, int flags, ...) {                              \
        static int (*real)(const char*, int, ...);                            \
        if (!real)                                                            \
            real = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, #name);   \
        va_list ap;                                                           \
        va_start(ap, flags);                                                  \
        int mode = (flags & (O_CREAT | O_TMPFILE)) ? va_arg(ap, int) : 0;     \
        va_end(ap);                                                           \
        path = redirect(path, &flags);                                        \
        return real(path, flags, mode);                                       \
    }

#define WRAP_OPENAT(name)                                                     \
    int name(int dirfd, const char* path, int flags, ...) {                   \
        static int (*real)(int, const char*, int, ...);                       \
        if (!real)                                                            \
            real = (int (*)(int, const char*, int, ...))dlsym(RTLD_NEXT, #name); \
        va_list ap;                                                           \
        va_start(ap, flags);                                                  \
        int mode = (flags & (O_CREAT | O_TMPFILE)) ? va_arg(ap, int) : 0;     \
        va_end(ap);                                                           \
        path = redirect(path, &flags);                                        \
        return real(dirfd, path, flags, mode);                                \
    }

WRAP_OPEN(open)
WRAP_OPEN(open64)
WRAP_OPENAT(openat)
WRAP_OPENAT(openat64)
