/* slowbind.so: LD_PRELOAD into fppd to make its startup reach the command
 * socket late, as it does on a device, where the outputs and plugins it
 * sets up first take seconds.  bind() of the command socket
 * (/run/fppd/FPPD) waits SLOWBIND_MS (default 1500) first.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
    static int (*real)(int, const struct sockaddr*, socklen_t);
    if (!real) {
        real = (int (*)(int, const struct sockaddr*, socklen_t))dlsym(RTLD_NEXT, "bind");
    }
    if (addr && addr->sa_family == AF_UNIX &&
        strcmp(((const struct sockaddr_un*)addr)->sun_path, "/run/fppd/FPPD") == 0) {
        const char* ms = getenv("SLOWBIND_MS");
        usleep((ms ? atoi(ms) : 1500) * 1000);
    }
    return real(fd, addr, len);
}
