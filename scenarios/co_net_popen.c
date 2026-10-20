/* co_net_popen.so: LD_PRELOAD into fppd to see, and answer, the commands it
 * runs with popen().
 *
 * $CO_POPEN_LOG:     a file each popen() command is appended to, one a line.
 * $CO_FAKEFQ_IFACES: comma-separated interface names whose root qdisc is
 *                    reported as fq: "tc qdisc show dev <name>" (with or
 *                    without -s) is answered here, without running tc, with
 *                    an fq line.  The container's kernel has no sch_fq, so
 *                    this is how a test gets fppd's kernel-paced send path;
 *                    a tbf qdisc on the interface then does the slow
 *                    draining that fq pacing would.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char FQ_LINE[] = "qdisc fq 8001: root refcnt 2 limit 10000p flow_limit 100p buckets 1024\n";

static int fake_fq(const char* cmd) {
    const char* list = getenv("CO_FAKEFQ_IFACES");
    const char* at = strstr(cmd, "qdisc show dev ");
    if (!list || !*list || !at) {
        return 0;
    }
    at += strlen("qdisc show dev ");
    size_t n = strcspn(at, " \t");
    const char* p = list;
    while (*p) {
        size_t len = strcspn(p, ",");
        if (len == n && strncmp(p, at, n) == 0) {
            return 1;
        }
        p += len;
        if (*p == ',') {
            p++;
        }
    }
    return 0;
}

FILE* popen(const char* cmd, const char* type) {
    static FILE* (*real)(const char*, const char*);
    if (!real) {
        real = (FILE * (*)(const char*, const char*)) dlsym(RTLD_NEXT, "popen");
    }
    const char* log = getenv("CO_POPEN_LOG");
    if (log && *log) {
        int fd = open(log, O_WRONLY | O_APPEND | O_CREAT, 0644);
        if (fd >= 0) {
            dprintf(fd, "%s\n", cmd);
            close(fd);
        }
    }
    if (type && type[0] == 'r' && fake_fq(cmd)) {
        return fmemopen((void*)FQ_LINE, sizeof(FQ_LINE) - 1, "r");
    }
    return real(cmd, type);
}
