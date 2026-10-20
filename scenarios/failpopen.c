/* failpopen.so: LD_PRELOAD into fppd to make popen() fail, as it does when
 * the box is out of memory or processes, for the commands whose text
 * contains $FAILPOPEN_MATCH.  Those return NULL with EAGAIN and append the
 * command to $FAILPOPEN_LOG; every other command runs as usual.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

FILE* popen(const char* cmd, const char* type) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "popen");
    }
    const char* match = getenv("FAILPOPEN_MATCH");
    if (match && *match && cmd && strstr(cmd, match)) {
        const char* log = getenv("FAILPOPEN_LOG");
        int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT, 0644) : -1;
        if (fd >= 0) {
            dprintf(fd, "%s\n", cmd);
            close(fd);
        }
        errno = EAGAIN;
        return NULL;
    }
    return real(cmd, type);
}
