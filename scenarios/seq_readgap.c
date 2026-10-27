/* seq_readgap.so: LD_PRELOAD into fppd to slow the sequence reader thread
 * down at one point: after it has decided to read the next frame (the file
 * is still open, the cache has room) and let go of the frame cache lock, but
 * before it takes the read lock.  Sequence::ReadFramesLoop() calls
 * GetTimeMS() there first; on the thread named FPP-ReadFrames, the first
 * call site seen is that one, and each call from it sleeps $SEQ_READGAP_MS
 * (default 20) first.  A stop or reopen made meanwhile then runs while the
 * reader is between its checks and its read, as on a busy player.
 *
 * GetTimeMS() is libfpp's, called through its PLT, so the preload replaces
 * it for libfpp's own callers too.  The C++ name is spelled out mangled.
 */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/time.h>
#include <unistd.h>

static __thread void* gap_site;

long long _Z9GetTimeMSv(void) {
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strcmp(name, "FPP-ReadFrames") == 0) {
        void* ra = __builtin_return_address(0);
        if (!gap_site) {
            gap_site = ra;
        }
        if (ra == gap_site) {
            const char* ms = getenv("SEQ_READGAP_MS");
            usleep((ms && *ms ? atoi(ms) : 20) * 1000);
        }
    }
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000LL + tv.tv_usec / 1000;
}
