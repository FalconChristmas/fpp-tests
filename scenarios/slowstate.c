/* slowstate.so: LD_PRELOAD into fppd to hold one kind of GStreamer state
 * change on one of its threads.  gst_element_set_state(..., SLOWSTATE_STATE)
 * called on a thread named SLOWSTATE_THREAD waits SLOWSTATE_MS (default
 * 1500) first, as a slow element's transition would.  States are GStreamer's
 * numbers: 1 NULL, 2 READY, 3 PAUSED, 4 PLAYING.  Only the outermost call
 * is held: the bins' own calls for their children, made inside it on the
 * same thread, are not (slownull.c holds each of them).  Nothing is linked
 * against GStreamer.
 *
 *   SLOWSTATE_MARK  a file created as each hold begins, so a scenario can
 *                   tell the held call was made.
 *   SLOWSTATE_ONCE  "1": only the first such call fppd makes is held.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

static __thread int depth;
static int held;

int gst_element_set_state(void* element, int state) {
    static int (*real)(void*, int);
    if (!real) {
        real = (int (*)(void*, int))dlsym(RTLD_NEXT, "gst_element_set_state");
    }
    const char* want = getenv("SLOWSTATE_STATE");
    const char* thread = getenv("SLOWSTATE_THREAD");
    if (want && thread && state == atoi(want) && depth == 0) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        const char* once = getenv("SLOWSTATE_ONCE");
        if (strcmp(name, thread) == 0 &&
            !(once && !strcmp(once, "1") && __atomic_exchange_n(&held, 1, __ATOMIC_SEQ_CST))) {
            const char* mark = getenv("SLOWSTATE_MARK");
            if (mark) {
                int fd = open(mark, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
                if (fd >= 0) {
                    close(fd);
                }
            }
            const char* ms = getenv("SLOWSTATE_MS");
            usleep((ms ? atoi(ms) : 1500) * 1000);
        }
    }
    depth++;
    int r = real(element, state);
    depth--;
    return r;
}
