/* parseerr.so: LD_PRELOAD into fppd to make a media pipeline's
 * gst_parse_launch() fail the way GStreamer calls recoverable: it returns the
 * pipeline AND sets an error (an element whose plugin is not installed, say).
 * While $PARSEERR_FLAG exists, a description starting "filesrc" (a media
 * pipeline, not fppd's startup probes) gets GST_PARSE_ERROR_NO_SUCH_ELEMENT.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct _GError GError;
typedef unsigned int GQuark;

void* gst_parse_launch(const char* desc, GError** error) {
    static void* (*real)(const char*, GError**);
    if (!real) {
        real = (void* (*)(const char*, GError**))dlsym(RTLD_NEXT, "gst_parse_launch");
    }
    void* pipeline = real(desc, error);
    const char* flag = getenv("PARSEERR_FLAG");
    if (pipeline && error && !*error && flag && access(flag, F_OK) == 0 &&
        strncmp(desc, "filesrc", 7) == 0) {
        GQuark (*quark)(void) = (GQuark (*)(void))dlsym(RTLD_DEFAULT, "gst_parse_error_quark");
        GError* (*mk)(GQuark, int, const char*) =
            (GError* (*)(GQuark, int, const char*))dlsym(RTLD_DEFAULT, "g_error_new_literal");
        *error = mk(quark(), 1 /* GST_PARSE_ERROR_NO_SUCH_ELEMENT */, "no element \"fake\"");
    }
    return pipeline;
}
