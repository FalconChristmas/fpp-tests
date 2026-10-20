/* failparse.so: LD_PRELOAD into fppd to make a pipeline fail to build.
 * gst_parse_launch() returns NULL, as for a description that doesn't
 * parse, for FAILPARSE_COUNT (default 1) descriptions that contain
 * FAILPARSE_MATCH (default "appsink name=sink", a video group's overlay
 * member), after letting the first FAILPARSE_SKIP (default 0) of them
 * through; every other call goes through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

void* gst_parse_launch(const char* desc, void** error) {
    static void* (*real)(const char*, void**);
    static int seen;
    if (!real) {
        real = (void* (*)(const char*, void**))dlsym(RTLD_NEXT, "gst_parse_launch");
    }
    const char* match = getenv("FAILPARSE_MATCH");
    const char* count = getenv("FAILPARSE_COUNT");
    const char* skip = getenv("FAILPARSE_SKIP");
    if (desc && strstr(desc, match ? match : "appsink name=sink")) {
        int n = __atomic_fetch_add(&seen, 1, __ATOMIC_SEQ_CST) - (skip ? atoi(skip) : 0);
        if (n >= 0 && n < (count ? atoi(count) : 1)) {
            if (error) {
                *error = NULL;
            }
            return NULL;
        }
    }
    return real(desc, error);
}
