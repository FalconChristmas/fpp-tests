/* warnclock.so: LD_PRELOAD into fppd to move the clock fppd's warnings see
 * -- and only that one -- forward, so a warning's timeout can pass without
 * waiting it out.  WarningHolder (Warnings.cpp) takes the time for a
 * timeout and for pruning from std::chrono::steady_clock::now(), which is
 * libstdc++'s and called through the PLT; this replaces it.  For a caller
 * whose symbol names a Warning (WarningHolder's methods), or that has no
 * symbol of its own and is called from one that does (the file-local
 * PruneWarnings(), from WarningHolder::WarningsThreadMain()), the time is
 * ahead by the number of seconds in $WARNCLOCK_FILE (none while the file
 * is missing or empty).  Every other caller gets the real clock.  Each
 * caller seen is appended to $WARNCLOCK_LOG once, as "<1 if shifted> <its
 * nearest symbol>", so a test can show the shifted clock reached the code
 * under test.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <execinfo.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SITES 128

static struct {
    void* ra;
    int warn;
} sites[SITES];
static int nsites;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static int is_warning_caller(void* ra) {
    int warn = -1;
    pthread_mutex_lock(&lock);
    for (int i = 0; i < nsites; i++) {
        if (sites[i].ra == ra) {
            warn = sites[i].warn;
            break;
        }
    }
    pthread_mutex_unlock(&lock);
    if (warn >= 0) {
        return warn;
    }
    Dl_info info = { 0 };
    warn = dladdr(ra, &info) && info.dli_sname && strstr(info.dli_sname, "Warning") != NULL;
    if (!warn && !info.dli_sname) {
        // A file-local function has no symbol of its own: go by its caller.
        void* frames[6];
        int n = backtrace(frames, 6);
        for (int i = 0; i + 1 < n; i++) {
            if (frames[i] == ra) {
                Dl_info up = { 0 };
                warn = dladdr(frames[i + 1], &up) && up.dli_sname &&
                       strstr(up.dli_sname, "Warning") != NULL;
                if (warn) {
                    info = up;
                }
                break;
            }
        }
    }
    const char* log = getenv("WARNCLOCK_LOG");
    int fd = log ? open(log, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644) : -1;
    if (fd >= 0) {
        const char* name = info.dli_sname ? info.dli_sname : "?";
        (void)!write(fd, warn ? "1 " : "0 ", 2);
        (void)!write(fd, name, strlen(name));
        (void)!write(fd, "\n", 1);
        close(fd);
    }
    pthread_mutex_lock(&lock);
    if (nsites < SITES) {
        sites[nsites].ra = ra;
        sites[nsites].warn = warn;
        nsites++;
    }
    pthread_mutex_unlock(&lock);
    return warn;
}

static long long shift_ns(void) {
    const char* path = getenv("WARNCLOCK_FILE");
    int fd = path ? open(path, O_RDONLY | O_CLOEXEC) : -1;
    if (fd < 0) {
        return 0;
    }
    char buf[32] = { 0 };
    (void)!read(fd, buf, sizeof(buf) - 1);
    close(fd);
    return atoll(buf) * 1000000000LL;
}

/* std::chrono::_V2::steady_clock::now(): a time_point, one int64 of ns. */
long long _ZNSt6chrono3_V212steady_clock3nowEv(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    long long ns = ts.tv_sec * 1000000000LL + ts.tv_nsec;
    if (is_warning_caller(__builtin_return_address(0))) {
        ns += shift_ns();
    }
    return ns;
}
