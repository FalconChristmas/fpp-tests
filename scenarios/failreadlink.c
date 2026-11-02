/* LD_PRELOAD shim: readlink("/proc/self/exe") fails, as it does when the
 * process may not read its own exe link (a hardened or chrooted setup), once
 * the file named by FAILREADLINK_FLAG exists; fppd reads the link at startup
 * and needs it then. Every other readlink goes through. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

ssize_t readlink(const char* path, char* buf, size_t len) {
    static ssize_t (*real)(const char*, char*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "readlink");
    const char* flag = getenv("FAILREADLINK_FLAG");
    if (path && strcmp(path, "/proc/self/exe") == 0 && flag && access(flag, F_OK) == 0) {
        errno = EACCES;
        return -1;
    }
    return real(path, buf, len);
}
