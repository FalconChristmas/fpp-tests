/* exitleakcheck.so: LD_PRELOAD into an ASan fppd to run LeakSanitizer at
 * its final _exit(). fppd ends with _exit() after its orderly cleanup, so
 * the leak check ASan would run at exit() never happens; this runs it there
 * (once the cleanup has freed what it frees), writing the report to the
 * ASAN_OPTIONS log_path, then exits as asked. Needs detect_leaks=1.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/syscall.h>
#include <unistd.h>

void _exit(int status) {
    int (*check)(void) = (int (*)(void))dlsym(RTLD_DEFAULT, "__lsan_do_recoverable_leak_check");
    if (check) {
        check();
    }
    syscall(SYS_exit_group, status);
    for (;;) {
    }
}
