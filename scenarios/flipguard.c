/* flipguard.so: LD_PRELOAD into fppd (a build without a sanitizer) to catch
 * a DRM page-flip event delivered to an object that has been freed.
 *
 * KMSFrameBuffer queues each flip with drmModePageFlip(..., user data) and
 * collects the completion through drmHandleEvent(), which calls the page
 * flip handler with that user data.  This records the user data of every
 * flip whose event has not been delivered yet; free() of one of them marks
 * it freed; and an event that then arrives for it is reported on stderr
 * ("flipguard: ...") and aborts fppd, where an ASan build would report a
 * heap-use-after-free.  User data that is not a heap pointer (a token) is
 * never freed, so it is never reported.
 *
 *   FLIPGUARD_LOG  if set, a file that gets one line per flip, event and
 *                  free of a pending flip's data ("flip/event/free <ptr>").
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern void __libc_free(void*);

typedef void (*flip_handler)(int, unsigned int, unsigned int, unsigned int, void*);

/* libdrm's drmEventContext through version 4; drmHandleEvent reads only the
 * fields the caller's version has. */
typedef struct {
    int version;
    flip_handler vblank_handler;
    flip_handler page_flip_handler;
    void (*page_flip_handler2)(int, unsigned int, unsigned int, unsigned int, unsigned int, void*);
    void (*sequence_handler)(int, uint64_t, uint64_t, uint64_t);
} event_context;

#define SLOTS 256
static void* pending[SLOTS]; /* flips queued, event not seen */
static void* freed[SLOTS];   /* of those, freed before the event came */
static int npending;
static volatile int lock;
static __thread flip_handler caller_handler;

static void take(void) {
    while (__atomic_exchange_n(&lock, 1, __ATOMIC_ACQUIRE)) {
    }
}
static void give(void) {
    __atomic_store_n(&lock, 0, __ATOMIC_RELEASE);
}

static void note(const char* what, void* p) {
    const char* path = getenv("FLIPGUARD_LOG");
    if (!path) {
        return;
    }
    FILE* f = fopen(path, "a");
    if (f) {
        fprintf(f, "%s %p\n", what, p);
        fclose(f);
    }
}

static void put(void** set, void* p) {
    for (int i = 0; i < SLOTS; i++) {
        if (!set[i]) {
            set[i] = p;
            return;
        }
    }
}

static int drop(void** set, void* p) {
    for (int i = 0; i < SLOTS; i++) {
        if (set[i] == p) {
            set[i] = NULL;
            return 1;
        }
    }
    return 0;
}

int drmModePageFlip(int fd, uint32_t crtc, uint32_t fb, uint32_t flags, void* data) {
    static int (*real)(int, uint32_t, uint32_t, uint32_t, void*);
    if (!real) {
        real = (int (*)(int, uint32_t, uint32_t, uint32_t, void*))dlsym(RTLD_NEXT, "drmModePageFlip");
    }
    int r = real(fd, crtc, fb, flags, data);
    if (r == 0 && data) {
        take();
        drop(freed, data); /* the address is in use again */
        if (!drop(pending, data)) {
            npending++;
        }
        put(pending, data);
        give();
        note("flip", data);
    }
    return r;
}

static void trampoline(int fd, unsigned int frame, unsigned int sec, unsigned int usec, void* data) {
    take();
    int dead = drop(freed, data);
    if (drop(pending, data)) {
        npending--;
    }
    give();
    note("event", data);
    if (dead) {
        char msg[160];
        int n = snprintf(msg, sizeof(msg),
                         "flipguard: page-flip event delivered to freed memory %p (freed with its flip pending)\n", data);
        write(2, msg, n);
        abort();
    }
    if (caller_handler) {
        caller_handler(fd, frame, sec, usec, data);
    }
}

int drmHandleEvent(int fd, event_context* ctx) {
    static int (*real)(int, event_context*);
    if (!real) {
        real = (int (*)(int, event_context*))dlsym(RTLD_NEXT, "drmHandleEvent");
    }
    if (!ctx || ctx->version < 2 || !ctx->page_flip_handler) {
        return real(fd, ctx);
    }
    event_context mine = { 0 };
    memcpy(&mine, ctx, ctx->version >= 4 ? sizeof(mine) : ctx->version >= 3 ? offsetof(event_context, sequence_handler) : offsetof(event_context, page_flip_handler2));
    flip_handler saved = caller_handler;
    caller_handler = ctx->page_flip_handler;
    mine.page_flip_handler = trampoline;
    int r = real(fd, &mine);
    caller_handler = saved;
    return r;
}

void free(void* p) {
    if (p && __atomic_load_n(&npending, __ATOMIC_RELAXED) > 0) {
        take();
        int was = drop(pending, p);
        if (was) {
            npending--;
            put(freed, p);
        }
        give();
        if (was) {
            note("free", p);
        }
    }
    __libc_free(p);
}
