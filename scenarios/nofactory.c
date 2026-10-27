/* nofactory.so: LD_PRELOAD into fppd to make one GStreamer element
 * unmakeable, as on an install missing its plugin.
 * gst_element_factory_make() returns NULL for the factory named in
 * NOFACTORY_NAME (default "pipewiresink"); every other call goes through.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

void* gst_element_factory_make(const char* factory, const char* name) {
    static void* (*real)(const char*, const char*);
    if (!real) {
        real = (void* (*)(const char*, const char*))dlsym(RTLD_NEXT, "gst_element_factory_make");
    }
    const char* missing = getenv("NOFACTORY_NAME");
    if (factory && strcmp(factory, missing ? missing : "pipewiresink") == 0) {
        return NULL;
    }
    return real(factory, name);
}
