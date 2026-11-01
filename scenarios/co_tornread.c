/* co_tornread.so: LD_PRELOAD into fppd to make one read of a file come back
 * empty, as a read of a config file still being written does.  While the
 * file $TORNREAD_ARM exists, the next fopen() of a path ending in
 * $TORNREAD_SUFFIX removes $TORNREAD_ARM and opens /dev/null instead; every
 * later open of the path, and every other path, reads the real file.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char* torn(const char* path) {
    const char* suffix = getenv("TORNREAD_SUFFIX");
    const char* arm = getenv("TORNREAD_ARM");
    if (!suffix || !arm || !path) {
        return path;
    }
    size_t n = strlen(path), m = strlen(suffix);
    if (n >= m && strcmp(path + n - m, suffix) == 0 && unlink(arm) == 0) {
        return "/dev/null";
    }
    return path;
}

FILE* fopen(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    }
    return real(torn(path), mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    }
    return real(torn(path), mode);
}
