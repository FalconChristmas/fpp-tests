/* killguard.so: LD_PRELOAD into fppd so that kill(-1, sig) or kill(0, sig)
 * signals nothing.  As root, kill(-1) ends every process on the box but init
 * and the caller: the whole container, or a device under run-local.sh.  Each
 * blocked call is appended to $KILLGUARD_LOG as "<pid> blocked kill(<target>, <sig>)";
 * every other kill() is passed on.
 *
 * On load it checks itself: it calls kill(-1, 0) the way fppd's own calls
 * resolve (the first definition in the global scope, which is a sanitizer's
 * interceptor or this) and logs "<pid> selftest blocked" only if the call
 * reached it.  A scenario that relies on the guard requires that line from
 * fppd's pid before it does anything that could send kill(-1).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static int in_selftest;

static void note(const char* what, pid_t target, int sig) {
    const char* path = getenv("KILLGUARD_LOG");
    if (!path)
        return;
    char line[128];
    int n = snprintf(line, sizeof(line), "%d %s kill(%d, %d)\n", (int)getpid(), what, (int)target, sig);
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd >= 0) {
        if (write(fd, line, n) < 0) {
        }
        close(fd);
    }
}

int kill(pid_t pid, int sig) {
    static int (*real)(pid_t, int);
    if (pid == -1 || pid == 0) {
        note(in_selftest ? "selftest blocked" : "blocked", pid, sig);
        return 0;
    }
    if (!real)
        real = (int (*)(pid_t, int))dlsym(RTLD_NEXT, "kill");
    return real(pid, sig);
}

__attribute__((constructor)) static void selftest(void) {
    int (*first)(pid_t, int) = (int (*)(pid_t, int))dlsym(RTLD_DEFAULT, "kill");
    if (!first)
        return;
    in_selftest = 1;
    first(-1, 0); /* signal 0 sends nothing even if the guard were missed */
    in_selftest = 0;
}
