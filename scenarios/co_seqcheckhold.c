/* co_seqcheckhold.so: LD_PRELOAD into fppd to hold the channel output thread
 * between finding no sequence running and acting on it.  The output thread
 * asks Sequence::IsSequenceRunning() while it holds outputThreadStatusLock
 * once a pass, to choose between the sequence's frame time and the bridging
 * interval; when that call, on the thread named FPP-ChannelOut with that lock
 * held, answers "not running", this sleeps $CO_SEQHOLD_MS (default 1000)
 * before returning, with the lock still held.  Each hold appends a line to
 * $CO_SEQHOLD_LOG, if set: its start and end on CLOCK_MONOTONIC, in seconds.
 *
 * Sequence::StartSequence() (the playlist's start of a sequence it has
 * opened) sleeps $CO_SEQHOLD_START_MS (default 0) first.  Opening the
 * sequence waits for the output thread's status lock, so without this the
 * start runs as soon as the thread lets go of it, ahead of the thread's next
 * check; with it the thread checks first and is held there when the start
 * comes.
 *
 * libfpp is built without -fvisibility=hidden, so its calls between source
 * files go through the PLT and bind to this.  The lock's owner is read from
 * glibc's pthread_mutex_t (the kernel tid of the holder, for a normal mutex),
 * which a std::mutex wraps.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

static int held_by_me(void) {
    static pthread_mutex_t* lock;
    if (!lock) {
        lock = (pthread_mutex_t*)dlsym(RTLD_DEFAULT, "outputThreadStatusLock");
        if (!lock) {
            return 0;
        }
    }
    return lock->__data.__owner == gettid();
}

int _ZN8Sequence17IsSequenceRunningEv(void* self) {
    static int (*real)(void*);
    if (!real) {
        real = (int (*)(void*))dlsym(RTLD_NEXT, "_ZN8Sequence17IsSequenceRunningEv");
    }
    int running = real(self);
    if (running) {
        return running;
    }
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "FPP-ChannelOut") != 0 || !held_by_me()) {
        return running;
    }
    struct timespec start, end;
    clock_gettime(CLOCK_MONOTONIC, &start);
    const char* ms = getenv("CO_SEQHOLD_MS");
    usleep((ms ? atoi(ms) : 1000) * 1000);
    clock_gettime(CLOCK_MONOTONIC, &end);
    const char* log = getenv("CO_SEQHOLD_LOG");
    if (log) {
        int fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd >= 0) {
            char line[64];
            int n = snprintf(line, sizeof(line), "%ld.%09ld %ld.%09ld\n", (long)start.tv_sec,
                             start.tv_nsec, (long)end.tv_sec, end.tv_nsec);
            write(fd, line, n);
            close(fd);
        }
    }
    return running;
}

void _ZN8Sequence13StartSequenceEv(void* self) {
    static void (*real)(void*);
    if (!real) {
        real = (void (*)(void*))dlsym(RTLD_NEXT, "_ZN8Sequence13StartSequenceEv");
    }
    const char* ms = getenv("CO_SEQHOLD_START_MS");
    if (ms && atoi(ms) > 0) {
        usleep(atoi(ms) * 1000);
    }
    real(self);
}
