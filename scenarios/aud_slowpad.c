/* aud_slowpad.so: LD_PRELOAD into fppd to hold decodebin's pad-added
 * callback on its streaming thread.  The first gst_pad_get_current_caps()
 * on a pad of an element named "decoder" (fppd's decodebin; the pad-added
 * handler asks for the new pad's caps first) creates $SLOWPAD_MARK and then
 * waits until $SLOWPAD_RELEASE exists (at most 30 s) before answering.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void* gst_pad_get_current_caps(void* pad) {
    static void* (*real)(void*);
    static void* (*parent_of)(void*);
    static char* (*name_of)(void*);
    static void (*unref)(void*);
    static void (*gfree)(void*);
    static int done;
    if (!real) {
        real = (void* (*)(void*))dlsym(RTLD_NEXT, "gst_pad_get_current_caps");
        parent_of = (void* (*)(void*))dlsym(RTLD_DEFAULT, "gst_pad_get_parent_element");
        name_of = (char* (*)(void*))dlsym(RTLD_DEFAULT, "gst_object_get_name");
        unref = (void (*)(void*))dlsym(RTLD_DEFAULT, "gst_object_unref");
        gfree = (void (*)(void*))dlsym(RTLD_DEFAULT, "g_free");
    }
    if (!done && parent_of && name_of) {
        void* parent = parent_of(pad);
        if (parent) {
            char* name = name_of(parent);
            int ours = name && strcmp(name, "decoder") == 0;
            gfree(name);
            unref(parent);
            if (ours) {
                done = 1;
                const char* mark = getenv("SLOWPAD_MARK");
                const char* release = getenv("SLOWPAD_RELEASE");
                if (mark) {
                    close(open(mark, O_CREAT | O_WRONLY, 0644));
                }
                for (int i = 0; release && i < 600 && access(release, F_OK) != 0; i++) {
                    usleep(50000);
                }
            }
        }
    }
    return real(pad);
}
