/* countgai.so: LD_PRELOAD into fppd to count the lookups of one name.
 * Every getaddrinfo() for $COUNTGAI_NAME appends a line (the calling
 * thread's name, then its call stack as readtrace.c records one) to
 * $COUNTGAI_FILE and fails with EAI_NONAME at once,
 * without asking the real resolver -- a configured output hostname that no
 * longer resolves, minus the seconds a real resolver takes to say so.
 * Every other name goes to the real getaddrinfo().
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <netdb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>

int getaddrinfo(const char* node, const char* service, const struct addrinfo* hints, struct addrinfo** res) {
    static int (*real)(const char*, const char*, const struct addrinfo*, struct addrinfo**);
    if (!real) {
        real = (int (*)(const char*, const char*, const struct addrinfo*, struct addrinfo**))dlsym(RTLD_NEXT, "getaddrinfo");
    }
    const char* name = getenv("COUNTGAI_NAME");
    if (!node || !name || strcmp(node, name) != 0) {
        return real(node, service, hints, res);
    }
    char thread[17] = { 0 };
    prctl(PR_GET_NAME, thread);
    const char* file = getenv("COUNTGAI_FILE");
    FILE* f = file ? fopen(file, "a") : NULL;
    if (f) {
        void* frames[48];
        int depth = backtrace(frames, 48);
        fprintf(f, "%s", thread);
        for (int i = 1; i < depth; i++) {
            Dl_info info;
            uintptr_t pc = (uintptr_t)frames[i] - 1;
            if (dladdr((void*)pc, &info) && info.dli_fname) {
                fprintf(f, " %s@%lx@%s", info.dli_fname, (unsigned long)(pc - (uintptr_t)info.dli_fbase),
                        info.dli_sname ? info.dli_sname : "-");
            }
        }
        fprintf(f, "\n");
        fclose(f);
    }
    return EAI_NONAME;
}
