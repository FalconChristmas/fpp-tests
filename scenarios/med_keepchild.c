/* med_keepchild.so: LD_PRELOAD into fppd to give it a child process that
 * never exits, as gst_ptp_init()'s gst-ptp-helper is. Before fppd's main()
 * runs, fork a child that execs `sleep 600` (killed with fppd, through
 * PR_SET_PDEATHSIG). Only in fppd itself: the child, and anything else
 * that inherits LD_PRELOAD, leaves it alone.
 */
#define _GNU_SOURCE
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

__attribute__((constructor)) static void keep_child(void) {
    char name[17] = "";
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "fppd") != 0 || getenv("KEEPCHILD_STARTED")) {
        return;
    }
    setenv("KEEPCHILD_STARTED", "1", 1);
    pid_t pid = fork();
    if (pid == 0) {
        prctl(PR_SET_PDEATHSIG, SIGKILL);
        execlp("sleep", "sleep", "600", (char*)NULL);
        _exit(127);
    }
}
