/* life_logstall.so: LD_PRELOAD into fppd to wedge a thread inside a write to
 * logs/fppd.log, as storage that stops answering does.  Once the file
 * $LIFE_LOGSTALL_FILE exists, the next fwrite(), fputs() or vfprintf() to a
 * stream open on a file named fppd.log, from any thread but the main one,
 * takes the stream's lock (as stdio does for the write) and never returns.
 * It creates $LIFE_LOGSTALL_FILE.held first, holding the lock.
 *
 * fppd writes its log through one persistent stream: this leaves fppd's own
 * log lock and the stream's lock with a thread that will not let go of
 * them, so anything that needs either -- a log line, fflush(NULL) -- waits
 * for ever.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int is_log(FILE* f) {
    if (!f || f == stdout || f == stderr) {
        return 0;
    }
    int fd = fileno(f);
    if (fd < 0) {
        return 0;
    }
    char link[64], path[4096];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, path, sizeof(path) - 1);
    if (n <= 0) {
        return 0;
    }
    path[n] = '\0';
    size_t len = strlen(path), want = strlen("/fppd.log");
    return len >= want && strcmp(path + len - want, "/fppd.log") == 0;
}

static void maybe_wedge(FILE* f) {
    const char* trigger = getenv("LIFE_LOGSTALL_FILE");
    if (!trigger || gettid() == getpid() || access(trigger, F_OK) != 0 || !is_log(f)) {
        return;
    }
    flockfile(f);
    char held[4096];
    snprintf(held, sizeof(held), "%s.held", trigger);
    int fd = open(held, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        close(fd);
    }
    for (;;) {
        pause();
    }
}

size_t fwrite(const void* p, size_t size, size_t n, FILE* f) {
    static size_t (*real)(const void*, size_t, size_t, FILE*);
    if (!real) {
        real = (size_t(*)(const void*, size_t, size_t, FILE*))dlsym(RTLD_NEXT, "fwrite");
    }
    maybe_wedge(f);
    return real(p, size, n, f);
}

int fputs(const char* s, FILE* f) {
    static int (*real)(const char*, FILE*);
    if (!real) {
        real = (int (*)(const char*, FILE*))dlsym(RTLD_NEXT, "fputs");
    }
    maybe_wedge(f);
    return real(s, f);
}

int vfprintf(FILE* f, const char* fmt, va_list ap) {
    static int (*real)(FILE*, const char*, va_list);
    if (!real) {
        real = (int (*)(FILE*, const char*, va_list))dlsym(RTLD_NEXT, "vfprintf");
    }
    maybe_wedge(f);
    return real(f, fmt, ap);
}
