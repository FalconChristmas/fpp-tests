/* aud_slowgstinit.so: LD_PRELOAD into fppd to make GStreamer's
 * initialisation slow, as it is the first time a box runs GStreamer (its
 * plugin registry is built then: ~20 s on a Pi).  gst_init() waits
 * $SLOWGSTINIT_MS (default 5000) before doing its work.  fppd starts it in
 * the background at startup, so this holds GStreamer uninitialised for the
 * first seconds of a scenario.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <unistd.h>

void gst_init(int* argc, char*** argv) {
    static void (*real)(int*, char***);
    if (!real) {
        real = (void (*)(int*, char***))dlsym(RTLD_NEXT, "gst_init");
    }
    const char* ms = getenv("SLOWGSTINIT_MS");
    usleep((ms ? atoi(ms) : 5000) * 1000);
    real(argc, argv);
}
