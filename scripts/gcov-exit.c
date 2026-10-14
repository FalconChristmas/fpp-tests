/* Preloaded into fppd by the coverage flavor (scenarios/fppd.py).
 *
 * fppd leaves through _exit(), which skips the exit-time dump that writes a
 * --coverage build's .gcda files, so nothing would be recorded. This _exit
 * dumps first. __gcov_dump() walks the list of every instrumented object in
 * the process (libfpp and the dlopen()ed outputs as well as fppd itself), so
 * whichever copy the weak reference binds to writes them all. */
#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>

extern void __gcov_dump(void) __attribute__((weak));

void _exit(int status) {
    if (__gcov_dump) {
        __gcov_dump();
    }
    syscall(SYS_exit_group, status);
    __builtin_unreachable();
}

void _Exit(int status) {
    _exit(status);
}
