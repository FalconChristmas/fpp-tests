/* gst_latedur.so: LD_PRELOAD into fppd so GStreamer seems to learn a file's
 * length late, as it does for formats whose length it finds only after
 * decoding has started.  gst_element_query_duration() on a pipeline (what
 * GStreamerOutput::Process() asks; GStreamer's own elements asking each
 * other are left alone) answers "not known" until $LATEDUR_MS milliseconds
 * after a pipeline was first asked, then asks the real one.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <time.h>

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000LL + ts.tv_nsec / 1000000;
}

int gst_element_query_duration(void* element, int format, long long* duration) {
    static int (*real)(void*, int, long long*);
    static unsigned long (*pipeline_type)(void);
    static int (*is_a)(void*, unsigned long);
    static long long first;
    if (!real) {
        real = (int (*)(void*, int, long long*))dlsym(RTLD_NEXT, "gst_element_query_duration");
        pipeline_type = (unsigned long (*)(void))dlsym(RTLD_DEFAULT, "gst_pipeline_get_type");
        is_a = (int (*)(void*, unsigned long))dlsym(RTLD_DEFAULT, "g_type_check_instance_is_a");
    }
    if (!element || !pipeline_type || !is_a || !is_a(element, pipeline_type())) {
        return real(element, format, duration);
    }
    long long t = now_ms();
    if (!first) {
        first = t;
    }
    const char* ms = getenv("LATEDUR_MS");
    if (ms && t - first < atoll(ms)) {
        return 0;
    }
    return real(element, format, duration);
}
