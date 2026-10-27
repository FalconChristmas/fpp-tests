/* med_holdplaying.so: LD_PRELOAD into fppd to hold its first move of a
 * pipeline to PLAYING. The first gst_element_set_state(..., GST_STATE_PLAYING)
 * creates $HOLDPLAYING_MARK and then waits $HOLDPLAYING_MS (default 3000)
 * before going ahead, as pipewiresink's READY->PAUSED does while its target
 * node is missing. Nothing is linked against GStreamer; GST_STATE_PLAYING
 * is 4.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

int gst_element_set_state(void* element, int state) {
    static int (*real)(void*, int);
    static int done;
    if (!real) {
        real = (int (*)(void*, int))dlsym(RTLD_NEXT, "gst_element_set_state");
    }
    if (state == 4 && !__atomic_exchange_n(&done, 1, __ATOMIC_SEQ_CST)) {
        const char* mark = getenv("HOLDPLAYING_MARK");
        const char* ms = getenv("HOLDPLAYING_MS");
        if (mark) {
            close(open(mark, O_CREAT | O_WRONLY, 0644));
        }
        usleep((ms ? atoi(ms) : 3000) * 1000);
    }
    return real(element, state);
}
