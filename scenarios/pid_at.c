/* pid_at PID CMD [ARGS...]: run CMD as a new process with the given PID
 * (clone3's set_tid, which needs CAP_SYS_ADMIN, as the test container has),
 * so a scenario can put an unrelated process on the PID a child of fppd's
 * gave up. Prints the PID and exits; the command runs on, in its own
 * session, on /dev/null. */
#define _GNU_SOURCE
#include <linux/sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char** argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: pid_at PID CMD [ARGS...]\n");
        return 2;
    }
    pid_t tid[1] = { (pid_t)atoi(argv[1]) };
    struct clone_args a;
    memset(&a, 0, sizeof(a));
    a.exit_signal = SIGCHLD;
    a.set_tid = (uint64_t)(uintptr_t)tid;
    a.set_tid_size = 1;
    long r = syscall(SYS_clone3, &a, sizeof(a));
    if (r < 0) {
        perror("clone3");
        return 1;
    }
    if (r == 0) {
        /* Off the caller's pipes, so it isn't waited for. */
        int null = open("/dev/null", O_RDWR);
        dup2(null, 0);
        dup2(null, 1);
        dup2(null, 2);
        setsid();
        execvp(argv[2], argv + 2);
        _exit(127);
    }
    printf("%ld\n", r);
    return 0;
}
