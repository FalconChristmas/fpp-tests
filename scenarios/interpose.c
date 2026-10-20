/* interpose.so: LD_PRELOAD into fppd to put globals named `addr` and `msgs`
 * ahead of libfpp's in the process's symbol scope, as any library or plugin
 * loaded earlier with a variable of those common names does.  A reference
 * in libfpp that goes through the GOT binds to these instead of its own.
 *
 * Both hold a known pattern, and are bigger than anything libfpp declares
 * under those names, so its stores land inside them.  A thread compares them
 * every 20 ms and, the first time one has changed, writes which to
 * $INTERPOSE_FILE: libfpp wrote through the name.
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define PATTERN 0xA5

unsigned char addr[256];
unsigned char msgs[65536];

static int changed(const unsigned char* p, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (p[i] != PATTERN) {
            return 1;
        }
    }
    return 0;
}

static void* watch(void* arg) {
    (void)arg;
    const char* file = getenv("INTERPOSE_FILE");
    for (;;) {
        const char* which = changed(addr, sizeof(addr)) ? "addr" : changed(msgs, sizeof(msgs)) ? "msgs" : NULL;
        if (which) {
            FILE* f = file ? fopen(file, "w") : NULL;
            if (f) {
                fprintf(f, "%s\n", which);
                fclose(f);
            }
            return NULL;
        }
        usleep(20000);
    }
}

__attribute__((constructor)) static void init(void) {
    memset(addr, PATTERN, sizeof(addr));
    memset(msgs, PATTERN, sizeof(msgs));
    pthread_t t;
    if (pthread_create(&t, NULL, watch, NULL) == 0) {
        pthread_detach(t);
    }
}
