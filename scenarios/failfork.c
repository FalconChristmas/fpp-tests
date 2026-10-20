/* failfork.so: LD_PRELOAD into fppd to make fork() fail, as it does when
 * the box is out of memory or processes.  While $FAILFORK_FLAG exists,
 * fork() returns -1 with EAGAIN and appends a line to $FAILFORK_LOG.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

pid_t fork(void) {
    static pid_t (*real)(void);
    if (!real) {
        real = (pid_t (*)(void))dlsym(RTLD_NEXT, "fork");
    }
    const char* flag = getenv("FAILFORK_FLAG");
    if (flag && access(flag, F_OK) == 0) {
        const char* log = getenv("FAILFORK_LOG");
        int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT, 0644) : -1;
        if (fd >= 0) {
            write(fd, "refused\n", 8);
            close(fd);
        }
        errno = EAGAIN;
        return -1;
    }
    return real();
}
