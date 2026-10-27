/* status_buildhold.so: LD_PRELOAD into fppd to hold one status build part-way
 * through.  GetCurrentFPPDStatus() reads the system uptime with sysinfo()
 * near its start; once the file $STATUS_BUILDHOLD_FILE exists, the first
 * sysinfo() on the thread named $STATUS_BUILDHOLD_THREAD returns (with the
 * uptime it read) only after sleeping $STATUS_BUILDHOLD_MS (default 2500).
 * It creates $STATUS_BUILDHOLD_FILE.held as the hold begins.  One hold per run.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/sysinfo.h>
#include <unistd.h>

static int held;

int sysinfo(struct sysinfo* info) {
    static int (*real)(struct sysinfo*);
    if (!real) {
        real = (int (*)(struct sysinfo*))dlsym(RTLD_NEXT, "sysinfo");
    }
    int rc = real(info);
    const char* trigger = getenv("STATUS_BUILDHOLD_FILE");
    const char* thread = getenv("STATUS_BUILDHOLD_THREAD");
    if (held || !trigger || !thread || access(trigger, F_OK) != 0) {
        return rc;
    }
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strcmp(name, thread) != 0) {
        return rc;
    }
    held = 1;
    char marker[4096];
    snprintf(marker, sizeof(marker), "%s.held", trigger);
    int fd = open(marker, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        close(fd);
    }
    const char* ms = getenv("STATUS_BUILDHOLD_MS");
    usleep((ms ? atoi(ms) : 2500) * 1000);
    return rc;
}
