/* slownull.so: LD_PRELOAD into fppd to make its pipeline teardowns wedge.
 * gst_element_set_state(..., GST_STATE_NULL) on fppd's teardown reaper
 * thread (named FPP-GstReaper) waits SLOWNULL_MS (default 12000) first:
 * longer than fppd waits for a teardown (10 s), so the pipeline is
 * abandoned as wedged, as a stalled sink's is on a device.  Nothing is
 * linked against GStreamer; GST_STATE_NULL is 1.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int gst_element_set_state(void* element, int state) {
    static int (*real)(void*, int);
    if (!real) {
        real = (int (*)(void*, int))dlsym(RTLD_NEXT, "gst_element_set_state");
    }
    if (state == 1) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        if (strcmp(name, "FPP-GstReaper") == 0) {
            const char* ms = getenv("SLOWNULL_MS");
            usleep((ms ? atoi(ms) : 12000) * 1000);
        }
    }
    return real(element, state);
}
