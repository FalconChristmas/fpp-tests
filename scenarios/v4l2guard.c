/* v4l2guard.so: LD_PRELOAD into fppd to put an inaccessible page right
 * after every buffer it maps from a V4L2 device (or a dma-buf one exports).
 *
 * A hardware decoder's frames are mmapped device buffers sized to the
 * picture; whether the page after one is mapped is up to where the kernel
 * happens to place it, so a read past the end of a frame faults on some
 * runs and not others.  Here it always faults.  Each guarded mapping is
 * logged ("<bytes>\n") to $V4L2GUARD_LOG, so a scenario can tell frames
 * really came through device memory.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int is_device(int fd) {
    char link[64], target[256];
    if (fd < 0)
        return 0;
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, target, sizeof target - 1);
    if (n <= 0)
        return 0;
    target[n] = 0;
    return strncmp(target, "/dev/video", 10) == 0 || strstr(target, "dmabuf") != NULL;
}

static void note(size_t len) {
    const char* path = getenv("V4L2GUARD_LOG");
    if (!path)
        return;
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd >= 0) {
        char line[32];
        int n = snprintf(line, sizeof line, "%zu\n", len);
        if (write(fd, line, n) < 0) {
        }
        close(fd);
    }
}

static void* guarded(void* (*real)(void*, size_t, int, int, int, off_t), void* addr, size_t len,
                     int prot, int flags, int fd, off_t off) {
    if (addr || (flags & MAP_FIXED) || !is_device(fd))
        return real(addr, len, prot, flags, fd, off);
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    size_t span = (len + page - 1) / page * page;
    // Reserve the buffer and one page more, inaccessible; map the buffer
    // over the front of it and leave the page after it as it is.
    void* base = real(NULL, span + page, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (base == MAP_FAILED)
        return real(addr, len, prot, flags, fd, off);
    void* p = real(base, len, prot, flags | MAP_FIXED, fd, off);
    if (p == MAP_FAILED) {
        munmap(base, span + page);
        return real(addr, len, prot, flags, fd, off);
    }
    note(len);
    return p;
}

void* mmap(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    static void* (*real)(void*, size_t, int, int, int, off_t);
    if (!real)
        real = (void* (*)(void*, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap");
    return guarded(real, addr, len, prot, flags, fd, off);
}

void* mmap64(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    static void* (*real)(void*, size_t, int, int, int, off_t);
    if (!real)
        real = (void* (*)(void*, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap64");
    return guarded(real, addr, len, prot, flags, fd, off);
}
