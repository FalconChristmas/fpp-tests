/* readtrace.so: LD_PRELOAD into fppd to record who reads one file.
 * Each fopen()/fopen64() for reading of a path ending in $READTRACE_SUFFIX
 * appends one line to $READTRACE_FILE: the call stack, as space-separated
 * "<object>@<offset hex>@<nearest exported symbol>" frames, for the scenario
 * to name with addr2line (which also sees inlined and local functions).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static __thread int busy;

static void trace(const char* path, const char* mode) {
    const char* suffix = getenv("READTRACE_SUFFIX");
    const char* file = getenv("READTRACE_FILE");
    if (busy || !suffix || !file || !path || !mode || mode[0] != 'r')
        return;
    size_t n = strlen(path), m = strlen(suffix);
    if (n < m || strcmp(path + n - m, suffix) != 0)
        return;
    busy = 1;
    void* frames[48];
    int depth = backtrace(frames, 48);
    FILE* f = fopen(file, "a");
    if (f) {
        for (int i = 1; i < depth; i++) {
            Dl_info info;
            /* -1: the call instruction, not the one after it */
            uintptr_t pc = (uintptr_t)frames[i] - 1;
            if (dladdr((void*)pc, &info) && info.dli_fname) {
                fprintf(f, "%s@%lx@%s ", info.dli_fname, (unsigned long)(pc - (uintptr_t)info.dli_fbase),
                        info.dli_sname ? info.dli_sname : "-");
            }
        }
        fprintf(f, "\n");
        fclose(f);
    }
    busy = 0;
}

FILE* fopen(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen");
    trace(path, mode);
    return real(path, mode);
}

FILE* fopen64(const char* path, const char* mode) {
    static FILE* (*real)(const char*, const char*);
    if (!real)
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "fopen64");
    trace(path, mode);
    return real(path, mode);
}
