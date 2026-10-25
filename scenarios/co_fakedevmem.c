/* co_fakedevmem.so: LD_PRELOAD into fppd to hand it ordinary memory for
 * /dev/mem: opening it returns a sparse memfd as large as the highest
 * physical address the PRU code maps, so every mmap() of it at a physical
 * offset succeeds and reads back what was written (zeros to begin with).
 * With remoteproc state files also visible, an AM62x fppd then leaves its
 * FAKE_PRU mode and runs the real-PRU path -- halting cores, remoteproc
 * start/stop -- against memory that no PRU reads.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define FAKE_SIZE 0x100000000LL

static int fake_fd(void) {
    int fd = memfd_create("fake-devmem", MFD_CLOEXEC);
    if (fd >= 0 && ftruncate(fd, FAKE_SIZE) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

#define OPEN_SHIM(name)                                                            \
    int name(const char* path, int flags, ...) {                                   \
        static int (*real)(const char*, int, ...);                                 \
        if (!real) {                                                               \
            real = (int (*)(const char*, int, ...))dlsym(RTLD_NEXT, #name);        \
        }                                                                          \
        if (path && strcmp(path, "/dev/mem") == 0) {                               \
            return fake_fd();                                                      \
        }                                                                          \
        va_list ap;                                                                \
        va_start(ap, flags);                                                       \
        int mode = va_arg(ap, int);                                                \
        va_end(ap);                                                                \
        return real(path, flags, mode);                                            \
    }

OPEN_SHIM(open)
OPEN_SHIM(open64)
