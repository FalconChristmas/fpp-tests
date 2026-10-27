/* vid_statehold.so: LD_PRELOAD into fppd to hold a pipeline's state change
 * open.  gst_element_set_state() taking a pipeline to STATEHOLD_TO
 * ("PAUSED", the default, or "NULL") from STATEHOLD_FROM ("PLAYING", the
 * default, "PAUSED" or "any") sleeps STATEHOLD_MS (default 1500) first,
 * then goes through.  With STATEHOLD_HAS set, only a pipeline holding an
 * element of that name is held (a video group member's appsink is "sink").
 * A park's PAUSED is PLAYING -> PAUSED; a member's teardown is -> NULL.
 * Every other call goes straight through.
 *
 * Each held call appends "hold <monotonic s>" and then "done <monotonic s>"
 * to STATEHOLD_LOG, if set -- or "revived" in place of "done" when a held
 * PAUSED finds the pipeline set to NULL meanwhile, so the pause takes a
 * torn-down pipeline back up.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <gst/gst.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void note(const char* what) {
    const char* path = getenv("STATEHOLD_LOG");
    if (!path) {
        return;
    }
    FILE* f = fopen(path, "a");
    if (!f) {
        return;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    fprintf(f, "%s %.3f\n", what, ts.tv_sec + ts.tv_nsec / 1e9);
    fclose(f);
}

static GstState named(const char* env, GstState dflt) {
    const char* v = getenv(env);
    if (!v) {
        return dflt;
    }
    if (!strcmp(v, "NULL")) {
        return GST_STATE_NULL;
    }
    if (!strcmp(v, "PAUSED")) {
        return GST_STATE_PAUSED;
    }
    if (!strcmp(v, "PLAYING")) {
        return GST_STATE_PLAYING;
    }
    return GST_STATE_VOID_PENDING;  // "any"
}

static int wanted(GstElement* element, GstState state) {
    if (!GST_IS_PIPELINE(element) || state != named("STATEHOLD_TO", GST_STATE_PAUSED)) {
        return 0;
    }
    GstState from = named("STATEHOLD_FROM", GST_STATE_PLAYING);
    if (from != GST_STATE_VOID_PENDING && GST_STATE(element) != from) {
        return 0;
    }
    const char* has = getenv("STATEHOLD_HAS");
    if (has) {
        GstElement* e = gst_bin_get_by_name(GST_BIN(element), has);
        if (!e) {
            return 0;
        }
        gst_object_unref(e);
    }
    return 1;
}

GstStateChangeReturn gst_element_set_state(GstElement* element, GstState state) {
    static GstStateChangeReturn (*real)(GstElement*, GstState);
    if (!real) {
        real = (GstStateChangeReturn (*)(GstElement*, GstState))dlsym(RTLD_NEXT, "gst_element_set_state");
    }
    if (!wanted(element, state)) {
        return real(element, state);
    }
    const char* ms = getenv("STATEHOLD_MS");
    note("hold");
    usleep((ms ? atoi(ms) : 1500) * 1000);
    int revived = state == GST_STATE_PAUSED && GST_STATE(element) == GST_STATE_NULL;
    GstStateChangeReturn r = real(element, state);
    note(revived ? "revived" : "done");
    return r;
}
