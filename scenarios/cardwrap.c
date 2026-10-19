/* cardwrap.so: LD_PRELOAD into fppd to make a sound card's hardware pointer
 * wrap at the ALSA boundary of a 32-bit kernel, 2^30 frames (~6 h at 48 kHz),
 * a few seconds into playback instead of hours.  fppd reads the card's
 * position from /proc/asound/cardN/pcmMp/subK/status (hw_ptr) and the
 * boundary from sw_params beside it; on their way through fopen() this
 * rewrites hw_ptr (and appl_ptr) to (ptr - first + B - rate * CARDWRAP_AT_S)
 * mod B, `first` being hw_ptr at fppd's first read after the card's latest
 * start (trigger_time), and boundary to B.  trigger_time and everything else are left as the card has
 * them, so the card doesn't look restarted.
 *
 * CARDWRAP_AT_S (default 5): seconds after that first read.
 * CARDWRAP_DEBUG: print each hw_ptr read, real and rewritten, to stderr.
 */
/* Both fopen and fopen64 are defined below.  With _FILE_OFFSET_BITS=64,
 * the default on Debian 13 armhf (and needed by _TIME_BITS=64), <stdio.h>
 * turns fopen into fopen64 and the two collide; fppd built that way calls
 * fopen64, the other build fopen, so the shim takes both, each passed on to
 * its own libc function -- fopen64's large-file support included. */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define BOUNDARY (1LL << 30)

static FILE* (*real_fopen)(const char*, const char*);

static long read_rate(const char* status_path) {
    char path[512];
    snprintf(path, sizeof(path), "%s", status_path);
    char* slash = strrchr(path, '/');
    if (!slash) return 48000;
    snprintf(slash, sizeof(path) - (slash - path), "/hw_params");
    FILE* f = real_fopen(path, "r");
    if (!f) return 48000;
    char line[256];
    long rate = 48000;
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, "rate:", 5) == 0) rate = atol(line + 5);
    }
    fclose(f);
    return rate > 0 ? rate : 48000;
}

static FILE* serve(const char* text) {
    int fd = memfd_create("cardwrap", 0);
    if (fd < 0) return NULL;
    size_t n = strlen(text);
    if (write(fd, text, n) != (ssize_t)n) { close(fd); return NULL; }
    lseek(fd, 0, SEEK_SET);
    return fdopen(fd, "r");
}

static long long first_hw = -1;
static char base_trigger[512];
static long long lead = 0;

static FILE* rewrite(const char* path, int is_status) {
    FILE* f = real_fopen(path, "r");
    if (!f) return NULL;
    char out[8192];
    size_t used = 0;
    char line[512];
    char trigger[512] = "";
    out[0] = 0;
    while (fgets(line, sizeof(line), f)) {
        char buf[512];
        const char* emit = line;
        if (strncmp(line, "trigger_time", 12) == 0) {
            snprintf(trigger, sizeof(trigger), "%s", line);
        }
        if (is_status && (strncmp(line, "hw_ptr", 6) == 0 || strncmp(line, "appl_ptr", 8) == 0)) {
            char* colon = strchr(line, ':');
            if (colon) {
                long long v = atoll(colon + 1);
                if (strncmp(line, "hw_ptr", 6) == 0 && (first_hw < 0 || strcmp(trigger, base_trigger) != 0)) {
                    // Based at the card's latest start: the first read, and
                    // again whenever it restarts (a new trigger_time), so the
                    // wrap always comes CARDWRAP_AT_S after it, whatever the
                    // card had counted before.  The lead is fixed per start:
                    // the rate can read differently while the card is being
                    // set up, and a moving lead would move the position.
                    const char* at = getenv("CARDWRAP_AT_S");
                    first_hw = v;
                    lead = (long long)((at ? atof(at) : 5.0) * read_rate(path));
                    snprintf(base_trigger, sizeof(base_trigger), "%s", trigger);
                }
                long long base = first_hw < 0 ? v : first_hw;
                long long fake = ((v - base) + BOUNDARY - lead) % BOUNDARY;
                if (fake < 0) fake += BOUNDARY;
                snprintf(buf, sizeof(buf), "%.*s: %lld\n", (int)(colon - line), line, fake);
                emit = buf;
                if (getenv("CARDWRAP_DEBUG") && strncmp(line, "hw_ptr", 6) == 0) {
                    fprintf(stderr, "cardwrap: %s real %lld fake %lld\n", path, v, fake);
                }
            }
        } else if (!is_status && strncmp(line, "boundary", 8) == 0) {
            char* colon = strchr(line, ':');
            if (colon) {
                snprintf(buf, sizeof(buf), "%.*s: %lld\n", (int)(colon - line), line, BOUNDARY);
                emit = buf;
            }
        }
        size_t n = strlen(emit);
        if (used + n + 1 < sizeof(out)) {
            memcpy(out + used, emit, n + 1);
            used += n;
        }
    }
    fclose(f);
    return serve(out);
}

typedef FILE* (*fopen_fn)(const char*, const char*);

static FILE* hook(const char* path, const char* mode, fopen_fn real) {
    if (!real_fopen) real_fopen = (fopen_fn)dlsym(RTLD_NEXT, "fopen");
    if (path && mode && mode[0] == 'r' && strncmp(path, "/proc/asound/card", 17) == 0 && strstr(path, "/sub")) {
        const char* base = strrchr(path, '/');
        if (base && strcmp(base, "/status") == 0) return rewrite(path, 1);
        if (base && strcmp(base, "/sw_params") == 0) return rewrite(path, 0);
    }
    return real(path, mode);
}

FILE* fopen(const char* path, const char* mode) {
    if (!real_fopen) real_fopen = (fopen_fn)dlsym(RTLD_NEXT, "fopen");
    return hook(path, mode, real_fopen);
}
FILE* fopen64(const char* path, const char* mode) {
    static fopen_fn real_fopen64;
    if (!real_fopen64) real_fopen64 = (fopen_fn)dlsym(RTLD_NEXT, "fopen64");
    return hook(path, mode, real_fopen64);
}
