/* fseq_nothread.so: LD_PRELOAD into fppd to make every FSEQ read-ahead
 * thread fail to start, as it does once a process is out of threads or (on
 * 32-bit) address space.
 *
 * The read-ahead thread is a pthread with a small stack: the handler sets
 * the size with pthread_attr_setstacksize() and calls pthread_create().
 * pthread_create itself can't be replaced usefully (the sanitizer runtime,
 * preloaded first, intercepts it and hands libc a start routine of its
 * own), so this replaces pthread_attr_setstacksize: called from the FSEQ
 * compressed handler (prepareRead() or startReadThread()), it asks for a
 * stack bigger than any address space, and libc's pthread_create then
 * fails with EAGAIN, exactly as it does when the process is out of room.
 *
 * Threads started through std::thread go through _M_start_thread, which
 * this replaces too: when the state's vtable symbol contains
 * $FSEQ_NOTHREAD_MATCH ("P8Sequence" picks Sequence's own read thread,
 * std::thread(ReadSequenceDataThread, this)) it throws std::system_error
 * EAGAIN without starting anything. With no match given it refuses the
 * read-ahead lambda in prepareRead(), which is how trees from before the
 * read-ahead became a pthread start it.
 *
 * $FSEQ_NOTHREAD_MATCH, if set, also replaces the default caller match for
 * the pthread path. $FSEQ_NOTHREAD_LIMIT, if set, refuses only that many
 * starts, so a scenario can see the one after a refusal succeed. Each
 * refusal appends a line to $FSEQ_NOTHREAD_FILE, so a scenario can tell the
 * refusal was reached.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*start_fn)(void* self, void** state, void (*dep)(void));
typedef int (*setstacksize_fn)(pthread_attr_t*, size_t);

/* std::__throw_system_error(int), exported by libstdc++. */
extern void _ZSt20__throw_system_errori(int) __attribute__((noreturn));

static int refused;

/* Whether a start whose symbol is `sym` is to be refused, recording it if so. */
static int refuse(const char* sym, int pthread_path) {
    const char* match = getenv("FSEQ_NOTHREAD_MATCH");
    const char* limit = getenv("FSEQ_NOTHREAD_LIMIT");
    int hit;
    if (!sym) {
        return 0;
    }
    if (match && *match) {
        hit = strstr(sym, match) != NULL;
    } else {
        /* the read-ahead: a pthread now, a std::thread lambda in prepareRead() in older trees */
        hit = strstr(sym, "11prepareRead") != NULL || (pthread_path && strstr(sym, "15startReadThread") != NULL);
    }
    if (!hit || (limit && refused >= atoi(limit))) {
        return 0;
    }
    refused++;
    const char* file = getenv("FSEQ_NOTHREAD_FILE");
    FILE* f = file ? fopen(file, "a") : NULL;
    if (f) {
        fprintf(f, "%s\n", sym);
        fclose(f);
    }
    return 1;
}

int pthread_attr_setstacksize(pthread_attr_t* attr, size_t size) {
    static setstacksize_fn real;
    if (!real) {
        real = (setstacksize_fn)dlsym(RTLD_NEXT, "pthread_attr_setstacksize");
    }
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && refuse(info.dli_sname, 1)) {
        size = (SIZE_MAX / 2) & ~(size_t)0xFFFF;
    }
    return real(attr, size);
}

/* std::thread::_M_start_thread(std::unique_ptr<_State>, void (*)()), a
 * member function: after `this`, the unique_ptr is passed by reference to
 * the caller's object, which holds the _State pointer. */
void _ZNSt6thread15_M_start_threadESt10unique_ptrINS_6_StateESt14default_deleteIS1_EEPFvvE(void* self, void** state, void (*dep)(void)) {
    static start_fn real;
    if (!real) {
        real = (start_fn)dlsym(RTLD_NEXT, "_ZNSt6thread15_M_start_threadESt10unique_ptrINS_6_StateESt14default_deleteIS1_EEPFvvE");
    }
    void* obj = state ? *state : NULL;
    Dl_info info;
    if (obj && dladdr(*(void**)obj, &info) && refuse(info.dli_sname, 0)) {
        _ZSt20__throw_system_errori(EAGAIN);
    }
    real(self, state, dep);
}
