/* lockwait.so: LD_PRELOAD into fppd to time how long fppd's own
 * mediaOutputLock keeps another thread waiting -- the lock the main loop
 * takes to process media on every pass, MultiSync for each master position
 * update and a remote's status build for its media fields.
 *
 * Once LOCKWAIT_DELAY_MS (default 5000) after startup, a thread of its own
 * takes and releases the lock LOCKWAIT_COUNT (default 500) times, a few
 * milliseconds apart, and writes to LOCKWAIT_OUT one line:
 *
 *   <samples> <waits over 1 ms> <median wait us> <longest wait us>
 *
 * The lock is found by name (a std::mutex is a pthread_mutex_t); if fppd
 * has none, the line is "missing".
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static long long now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}

static int cmp(const void* a, const void* b) {
    long long x = *(const long long*)a, y = *(const long long*)b;
    return x < y ? -1 : x > y;
}

static void* run(void* arg) {
    (void)arg;
    const char* out = getenv("LOCKWAIT_OUT");
    const char* d = getenv("LOCKWAIT_DELAY_MS");
    const char* c = getenv("LOCKWAIT_COUNT");
    int count = c ? atoi(c) : 500;
    usleep((d ? atoi(d) : 5000) * 1000);
    FILE* f = out ? fopen(out, "w") : NULL;
    if (!f) {
        return NULL;
    }
    // libfpp.so is loaded by now: fppd links it.
    pthread_mutex_t* lock = (pthread_mutex_t*)dlsym(RTLD_DEFAULT, "mediaOutputLock");
    if (!lock || count < 1) {
        fprintf(f, "missing\n");
        fclose(f);
        return NULL;
    }
    long long* waits = calloc(count, sizeof(long long));
    int over = 0;
    for (int i = 0; i < count; i++) {
        long long t = now_us();
        pthread_mutex_lock(lock);
        waits[i] = now_us() - t;
        pthread_mutex_unlock(lock);
        if (waits[i] > 1000) {
            over++;
        }
        // spread over the display's refresh, not in step with it
        usleep(2000 + (i * 7919) % 3000);
    }
    qsort(waits, count, sizeof(long long), cmp);
    fprintf(f, "%d %d %lld %lld\n", count, over, waits[count / 2], waits[count - 1]);
    fclose(f);
    free(waits);
    return NULL;
}

__attribute__((constructor)) static void start(void) {
    // Only in fppd itself, not in what it runs.
    char exe[256];
    ssize_t n = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    if (n <= 0) {
        return;
    }
    exe[n] = 0;
    const char* base = strrchr(exe, '/');
    if (strcmp(base ? base + 1 : exe, "fppd")) {
        return;
    }
    pthread_t t;
    if (pthread_create(&t, NULL, run, NULL) == 0) {
        pthread_detach(t);
    }
}
