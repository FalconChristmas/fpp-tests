/* slowclose.so: LD_PRELOAD into fppd to widen the moment between a WLED API
 * client thread closing its connection's socket and that thread finishing
 * with the connection.  close() of a socket on a thread named
 * "FPP-WLEDAPI-cli" returns SLOWCLOSE_MS (default 300) late.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

int close(int fd) {
    static int (*real)(int);
    if (!real) {
        real = (int (*)(int))dlsym(RTLD_NEXT, "close");
    }
    struct stat st;
    int sock = fstat(fd, &st) == 0 && S_ISSOCK(st.st_mode);
    int r = real(fd);
    if (sock) {
        char name[16] = { 0 };
        prctl(PR_GET_NAME, name);
        if (strcmp(name, "FPP-WLEDAPI-cli") == 0) {
            const char* ms = getenv("SLOWCLOSE_MS");
            usleep((ms ? atoi(ms) : 300) * 1000);
        }
    }
    return r;
}
