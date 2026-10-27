/* countdurquery.so: LD_PRELOAD into fppd to count its pipeline duration
 * queries. Every gst_element_query_duration() call goes through, and the
 * running count is written to the file named by COUNTDURQUERY_FILE.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int gst_element_query_duration(void* element, int format, long long* duration) {
    static int (*real)(void*, int, long long*);
    static long count;
    if (!real) {
        real = (int (*)(void*, int, long long*))dlsym(RTLD_NEXT, "gst_element_query_duration");
    }
    long n = __atomic_add_fetch(&count, 1, __ATOMIC_SEQ_CST);
    const char* path = getenv("COUNTDURQUERY_FILE");
    if (path) {
        int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            char buf[32];
            int len = snprintf(buf, sizeof(buf), "%ld\n", n);
            if (write(fd, buf, len) < 0) {
            }
            close(fd);
        }
    }
    return real(element, format, duration);
}
