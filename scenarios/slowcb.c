/* slowcb.so: LD_PRELOAD into fppd to hold its ping thread inside a ping
 * callback, so a scenario can act while the callback is running.  The first
 * fwrite() on the thread named FPP-PingThread whose text contains
 * SLOWCB_TEXT (default "Could ping host", the log line of a controller
 * coming back) creates the file SLOWCB_MARK, if set, and then sleeps
 * SLOWCB_MS (default 2000) before writing.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

size_t fwrite(const void* buf, size_t size, size_t n, FILE* f) {
    static size_t (*real)(const void*, size_t, size_t, FILE*);
    static int done;
    if (!real) {
        real = (size_t (*)(const void*, size_t, size_t, FILE*))dlsym(RTLD_NEXT, "fwrite");
    }
    const char* text = getenv("SLOWCB_TEXT");
    if (!text) {
        text = "Could ping host";
    }
    if (!done && buf && memmem(buf, size * n, text, strlen(text))) {
        char name[17] = { 0 };
        prctl(PR_GET_NAME, name);
        if (strcmp(name, "FPP-PingThread") == 0) {
            done = 1;
            const char* mark = getenv("SLOWCB_MARK");
            if (mark) {
                close(open(mark, O_CREAT | O_WRONLY, 0644));
            }
            const char* ms = getenv("SLOWCB_MS");
            usleep((ms ? atoi(ms) : 2000) * 1000);
        }
    }
    return real(buf, size, n, f);
}
