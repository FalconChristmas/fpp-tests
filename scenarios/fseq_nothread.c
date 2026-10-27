/* fseq_nothread.so: LD_PRELOAD into fppd to make every FSEQ read-ahead
 * thread fail to start, as it does once a process is out of threads or (on
 * 32-bit) address space.
 *
 * std::thread's constructor hands its callable, wrapped in a _State_impl,
 * to std::thread::_M_start_thread, which throws std::system_error when
 * pthread_create fails.  This replaces _M_start_thread (pthread_create
 * itself belongs to the sanitizer runtime, which is preloaded first): when
 * the state's vtable is the one for a lambda defined in a prepareRead()
 * -- the FSEQ compressed handler's read-ahead -- it throws exactly that
 * error, EAGAIN, without starting anything; every other thread starts as
 * usual.  Each refusal appends a line to $FSEQ_NOTHREAD_FILE, so a scenario
 * can tell the refusal was reached.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*start_fn)(void* self, void** state, void (*dep)(void));

/* std::__throw_system_error(int), exported by libstdc++. */
extern void _ZSt20__throw_system_errori(int) __attribute__((noreturn));

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
    if (obj && dladdr(*(void**)obj, &info) && info.dli_sname && strstr(info.dli_sname, "11prepareRead")) {
        const char* file = getenv("FSEQ_NOTHREAD_FILE");
        FILE* f = file ? fopen(file, "a") : NULL;
        if (f) {
            fprintf(f, "%s\n", info.dli_sname);
            fclose(f);
        }
        _ZSt20__throw_system_errori(EAGAIN);
    }
    real(self, state, dep);
}
