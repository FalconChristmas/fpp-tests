/* co_slowsetoutput.so: LD_PRELOAD into fppd to hold OutputMonitor::SetOutput()
 * for $CO_SLOWSETOUTPUT_MS (default 50) after each lock it releases -- the
 * points where it has collected its smart-receiver actions and is about to
 * hand them to FalconV5Support's callback -- so that a string config reload
 * destroying the callback's owner lands in that window, every time.
 *
 * A release is SetOutput()'s when SetOutput() (its extent from the symbol
 * table) is among the unlock's first few callers -- directly, through an inlined std::unique_lock, or through
 * std::unique_lock's own unlock() in a sanitizer build. Needs frame pointers
 * (fppd's asan, tsan and debug flavors). The first hold is announced on
 * stderr, so a scenario can tell the shim found its mark.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <link.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define SETOUTPUT "_ZN13OutputMonitor9SetOutputERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEEb"

static __thread int inside;
static uintptr_t setoutput;
static uintptr_t setoutput_end;
static int resolved;

/* Whether SetOutput() is among the first few callers, walking the frame
 * records (fppd's sanitizer and debug builds keep frame pointers; where a
 * frame has none the walk stops at the first address off this stack). */
__attribute__((noinline, optimize("no-omit-frame-pointer")))
static int called_from_setoutput(void) {
    uintptr_t* fp = (uintptr_t*)__builtin_frame_address(0);
    uintptr_t sp = (uintptr_t)fp;  // frame records only go up the stack from here
    for (int i = 0; i < 6 && fp; i++) {
        if ((uintptr_t)fp < sp || (uintptr_t)fp > sp + (8 << 20) || ((uintptr_t)fp & 7)) {
            return 0;
        }
        uintptr_t ret = fp[1];
        if (ret >= setoutput && ret < setoutput_end) {
            return 1;
        }
        fp = (uintptr_t*)fp[0];
    }
    return 0;
}

static void resolve(void) {
    void* lib = dlopen("libfpp.so", RTLD_NOW | RTLD_NOLOAD);
    setoutput = (uintptr_t)dlsym(lib ? lib : RTLD_DEFAULT, SETOUTPUT);
    // the function's own extent: a sanitizer build of it runs past 8 KB
    Dl_info info;
    const ElfW(Sym)* sym = NULL;
    if (setoutput && dladdr1((void*)setoutput, &info, (void**)&sym, RTLD_DL_SYMENT) && sym && sym->st_size) {
        setoutput_end = setoutput + sym->st_size;
    } else {
        setoutput_end = setoutput + 65536;
    }
    resolved = setoutput != 0;
}

__attribute__((constructor)) static void co_slowsetoutput_init(void) {
    inside = 1;
    resolve();
    inside = 0;
}

__attribute__((noinline, optimize("no-omit-frame-pointer")))
static void maybe_hold(void) {
    if (inside) {
        return;
    }
    if (!resolved) {
        // libfpp is loaded before any of fppd's own code runs; until then
        // there is nothing to hold
        return;
    }
    if (resolved && called_from_setoutput()) {
        static int announced;
        if (!__atomic_exchange_n(&announced, 1, __ATOMIC_RELAXED)) {
            fprintf(stderr, "co_slowsetoutput: holding OutputMonitor::SetOutput\n");
        }
        const char* ms = getenv("CO_SLOWSETOUTPUT_MS");
        usleep((ms ? atoi(ms) : 50) * 1000);
    }
}

__attribute__((optimize("no-omit-frame-pointer")))
int pthread_mutex_unlock(pthread_mutex_t* m) {
    static int (*real)(pthread_mutex_t*);
    if (!real) {
        real = (int (*)(pthread_mutex_t*))dlsym(RTLD_NEXT, "pthread_mutex_unlock");
    }
    int rc = real(m);
    maybe_hold();
    return rc;
}

__attribute__((optimize("no-omit-frame-pointer")))
int pthread_rwlock_unlock(pthread_rwlock_t* l) {
    static int (*real)(pthread_rwlock_t*);
    if (!real) {
        real = (int (*)(pthread_rwlock_t*))dlsym(RTLD_NEXT, "pthread_rwlock_unlock");
    }
    int rc = real(l);
    maybe_hold();
    return rc;
}
