/* zstdfail.so: LD_PRELOAD into a program that writes zstd (fsequtils) to
 * make every ZSTD_compressStream2() call fail, as it does when zstd runs
 * out of memory: it returns zstd's GENERIC error code and consumes
 * nothing.  Each failed call is counted in $ZSTDFAIL_LOG (one byte per
 * call, up to a limit, so a caller that spins doesn't fill the disk).
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stddef.h>
#include <stdlib.h>
#include <unistd.h>

size_t ZSTD_compressStream2(void* cctx, void* output, void* input, int endOp) {
    static int logged;
    (void)cctx;
    (void)output;
    (void)input;
    (void)endOp;
    const char* log = getenv("ZSTDFAIL_LOG");
    if (log && logged < 1000) {
        int fd = open(log, O_WRONLY | O_APPEND | O_CREAT, 0644);
        if (fd >= 0) {
            (void)!write(fd, "x", 1);
            close(fd);
        }
        logged++;
    }
    return (size_t)-1; /* ERROR(GENERIC) */
}
