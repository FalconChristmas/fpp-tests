/* slowfileopen.so: LD_PRELOAD into fppd to make opening a given file for
 * reading slow, as a sequence on a busy SD card or a network mount is.
 * fopen()/fopen64() of a path ending in $SLOWFILEOPEN_SUFFIX, for reading,
 * waits $SLOWFILEOPEN_MS (default 2000) first.  FSEQFile opens sequences
 * with fopen().
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void maybe_wait(const char* path, const char* mode) {
    const char* suffix = getenv("SLOWFILEOPEN_SUFFIX");
    if (!suffix || !path || !mode || mode[0] != 'r')
        return;
    size_t n = strlen(path), m = strlen(suffix);
    if (n < m || strcmp(path + n - m, suffix) != 0)
        return;
    const char* ms = getenv("SLOWFILEOPEN_MS");
    usleep((ms ? atoi(ms) : 2000) * 1000);
}

FILE* fopen(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    maybe_wait(path, mode);
    return real(path, mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    maybe_wait(path, mode);
    return real(path, mode);
}
