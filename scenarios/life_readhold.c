/* life_readhold.so: LD_PRELOAD into fppd to hold the sequence reader thread
 * in the middle of reading a frame.  FSEQFile reads a frame as fseeko() then
 * fread() on the file's stream; once the file $LIFE_READHOLD_FILE exists, the
 * first fseeko() on the thread named FPP-ReadFrames returns only after
 * sleeping $LIFE_READHOLD_MS (default 1500) -- with the seek done and the
 * read still to come.  It creates $LIFE_READHOLD_FILE.held as the hold
 * begins.  One hold per run.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

static int held;

static void maybe_hold(void) {
    const char* trigger = getenv("LIFE_READHOLD_FILE");
    if (held || !trigger || access(trigger, F_OK) != 0) {
        return;
    }
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "FPP-ReadFrames") != 0) {
        return;
    }
    held = 1;
    char marker[4096];
    snprintf(marker, sizeof(marker), "%s.held", trigger);
    int fd = open(marker, O_WRONLY | O_CREAT | O_CLOEXEC, 0644);
    if (fd >= 0) {
        close(fd);
    }
    const char* ms = getenv("LIFE_READHOLD_MS");
    usleep((ms ? atoi(ms) : 1500) * 1000);
}

int fseeko(FILE* f, off_t off, int whence) {
    static int (*real)(FILE*, off_t, int);
    if (!real) {
        real = (int (*)(FILE*, off_t, int))dlsym(RTLD_NEXT, "fseeko");
    }
    int rc = real(f, off, whence);
    maybe_hold();
    return rc;
}

int fseeko64(FILE* f, off64_t off, int whence) {
    static int (*real)(FILE*, off64_t, int);
    if (!real) {
        real = (int (*)(FILE*, off64_t, int))dlsym(RTLD_NEXT, "fseeko64");
    }
    int rc = real(f, off, whence);
    maybe_hold();
    return rc;
}
