/* meter_slowconnect.so: LD_PRELOAD into fppd to make one PipeWire stream
 * slow to connect, as a PipeWire daemon slow to answer makes a pipewiresrc.
 * Once $SLOWCONNECT_ARM exists, the first pw_stream_connect() creates
 * $SLOWCONNECT_MARK, sleeps $SLOWCONNECT_MS (default 3000) and then
 * connects. Streams connected before the arm file appears, and every one
 * after the first, are left alone.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

static int done;

int pw_stream_connect(void* stream, int direction, uint32_t target_id, int flags, const void** params,
                      uint32_t n_params) {
    static int (*real)(void*, int, uint32_t, int, const void**, uint32_t);
    if (!real) {
        // libpipewire comes in with GStreamer's PipeWire plugin, opened
        // RTLD_LOCAL, so RTLD_NEXT doesn't see it: ask the loaded library.
        void* lib = dlopen("libpipewire-0.3.so.0", RTLD_LAZY | RTLD_NOLOAD);
        real = (int (*)(void*, int, uint32_t, int, const void**, uint32_t))dlsym(lib ? lib : RTLD_NEXT,
                                                                               "pw_stream_connect");
    }
    const char* arm = getenv("SLOWCONNECT_ARM");
    if (!done && arm && access(arm, F_OK) == 0) {
        done = 1;
        const char* mark = getenv("SLOWCONNECT_MARK");
        if (mark) {
            close(open(mark, O_CREAT | O_WRONLY, 0644));
        }
        const char* ms = getenv("SLOWCONNECT_MS");
        usleep((useconds_t)(ms ? atoi(ms) : 3000) * 1000);
    }
    return real(stream, direction, target_id, flags, params, n_params);
}
