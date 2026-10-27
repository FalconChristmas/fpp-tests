/* sched_rangehold.so: LD_PRELOAD into fppd to hold GET /fppd/schedule/range
 * between taking its copy of the schedule and walking the days.
 * Scheduler::GetScheduleRange copies the schedule under the lock, then calls
 * localtime_r(&rangeStart) to start the walk; the first localtime_r() whose
 * time is $SCHED_RANGEHOLD_T returns only after sleeping $SCHED_RANGEHOLD_MS
 * (default 3000). A test asks for a range starting at a time nothing else in
 * fppd converts, so only that request is held. It creates $SCHED_RANGEHOLD_FILE
 * (when set) as the hold begins. One hold per run.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

static int held;

static void maybe_hold(const time_t* t) {
    const char* want = getenv("SCHED_RANGEHOLD_T");
    if (held || !want || !t || *t != (time_t)atoll(want)) {
        return;
    }
    held = 1;
    const char* marker = getenv("SCHED_RANGEHOLD_FILE");
    if (marker) {
        int fd = open(marker, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
        if (fd >= 0) {
            close(fd);
        }
    }
    const char* ms = getenv("SCHED_RANGEHOLD_MS");
    usleep((ms ? atoi(ms) : 3000) * 1000);
}

struct tm* localtime_r(const time_t* t, struct tm* result) {
    static struct tm* (*real)(const time_t*, struct tm*);
    if (!real) {
        real = (struct tm * (*)(const time_t*, struct tm*)) dlsym(RTLD_NEXT, "localtime_r");
    }
    maybe_hold(t);
    return real(t, result);
}
