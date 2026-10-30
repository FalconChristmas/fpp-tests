/* fakedrm.so: LD_PRELOAD into fppd to give it a Raspberry Pi 3's display card
 * where there is none (Docker), with the vc4 driver's display load limit.
 *
 * The card is /dev/dri/card0: one HDMI-A-1 connector with a display on it
 * (EDID, 1920x1080@60 preferred, 1280x720@60), its encoder, one CRTC already
 * running 1920x1080@60 (as the console leaves it), a primary plane and three
 * overlays.  fppd drives it through libdrm, so the libdrm calls fppd and
 * fakekms.c make are answered here; an fd open on the card or a lease is an
 * eventfd, readable while a page-flip or vblank event is waiting for it.
 * Dumb buffers map as anonymous memory.  /sys/class/drm/<name> is read from
 * $FAKEDRM_DIR/sys/class/drm/<name> (fakedrm.py writes it); no other card
 * exists, under /dev/dri or /sys/class/drm.
 *
 * The load limit is the kernel's (vc4_plane_calc_load(), checked by
 * vc4_load_tracker_atomic_check(), enforced on VC4 gen 4 only).  Every
 * enabled plane costs
 *
 *   hvs    = fb planes * crtc_w * crtc_h * vrefresh / (scaled ? 2 : 4)
 *   membus = sum over fb planes of src_w * src_h * vscale * cpp * vrefresh
 *
 * a YUV plane counting as scaled whatever its size (the driver forces the
 * chroma scaler on).  A plane or CRTC commit that takes the total over
 * 240M cycles/s or 1.5 GB/s fails with ENOSPC, as on the Pi; the kernel says
 * nothing, and neither does this, except to $FAKEDRM_LOG.
 *
 *   FAKEDRM_DIR           where the fake sysfs files are
 *   FAKEDRM_LOG           commits that change a plane, and refusals, one line each
 *   FAKEDRM_LOAD_TRACKER  "0": no limit (debugfs hvs_load_tracker = N)
 *   FAKEDRM_CONNECTOR     "DPI-1": the connector is a DPI panel instead, with
 *                         the one mode FPP's DPI overlay sets up (1920x997,
 *                         38.4 MHz, 1921 x 1000 total: 20 Hz), the CRTC
 *                         running it; "DSI-1": a DSI panel, 800x480@60 as
 *                         the official 7" touchscreen
 *   FAKEDRM_CRTC_OFF      "1": the CRTC starts off, as with no console on
 *                         the display (nothing plugged in at boot)
 *   FAKEDRM_FAIL_MODESET  a path: while it exists, every modeset
 *                         (drmModeSetCrtc() with a mode) fails with EBUSY,
 *                         and is logged as refused
 *   FAKEDRM_MM            "WxH": the screen size the EDID claims, in mm
 *                         (default 520x290)
 *   FAKEDRM_PREFERRED     "1280x800": the display prefers 1280x800 (a WXGA
 *                         projector), with 1280x720 as well
 *   FAKEDRM_REFUSE_PLANES "1": every plane commit fails with ENOSPC, as the
 *                         kernel's source-rectangle check refuses real
 *                         kmssink's non-square-pixel source size (GStreamer
 *                         #1555, FPP #3135) -- the stand-in sink sources the
 *                         frame's own size, so it can't trip that by itself
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>
#include <drm_fourcc.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define CARD "/dev/dri/card0"
#define SYSFS "/sys/class/drm/"

#define CONN_ID 35
#define ENC_ID 34
#define CRTC_ID 97
#define PROP_EDID 1
#define PROP_TYPE 2
#define EDID_BLOB 300

#define HVS_LIMIT 240000000ULL
#define MEMBUS_LIMIT (1536ULL * 1024 * 1024)

typedef struct {
    uint32_t id;
    int type;  // DRM_PLANE_TYPE_*
    uint32_t crtc, fb;
    int32_t cx, cy;
    uint32_t cw, ch, sx, sy, sw, sh;  // src in 16.16
} Plane;

static Plane planes[] = {
    { .id = 86, .type = DRM_PLANE_TYPE_PRIMARY },
    { .id = 98, .type = DRM_PLANE_TYPE_OVERLAY },
    { .id = 109, .type = DRM_PLANE_TYPE_OVERLAY },
    { .id = 120, .type = DRM_PLANE_TYPE_OVERLAY },
};
#define NPLANES ((int)(sizeof(planes) / sizeof(planes[0])))

static const uint32_t FORMATS[] = {
    DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888, DRM_FORMAT_RGB888, DRM_FORMAT_BGR888, DRM_FORMAT_RGB565,
    DRM_FORMAT_YUV420, DRM_FORMAT_YVU420, DRM_FORMAT_NV12, DRM_FORMAT_NV21,
};
#define NFORMATS ((int)(sizeof(FORMATS) / sizeof(FORMATS[0])))

typedef struct {
    uint32_t id, w, h, format;
    int owner;  // the fd it was added on: closing that fd removes it
} Fb;

typedef struct {
    int fd;
    int signalled;  // its eventfd has been written
    int flip;       // page flip (else vblank)
    uint64_t due_us;
    uint32_t seq;
    void* data;
} Event;

#define MAXFILES 64
#define MAXFBS 256
#define MAXEVENTS 64

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int files[MAXFILES];
static int nfiles;
static Fb fbs[MAXFBS];
static uint32_t next_fb = 600, next_handle, next_lessee;
static Event events[MAXEVENTS];
static int nevents;
static int timer_started;
static int crtc_active = 1, flip_pending;
static drmModeModeInfo crtc_mode;

static drmModeModeInfo mode(int w, int h, uint32_t clock, int hs, int he, int ht, int vs, int ve, int vt,
                            uint32_t type) {
    drmModeModeInfo m;
    memset(&m, 0, sizeof(m));
    m.clock = clock;
    m.hdisplay = w, m.hsync_start = hs, m.hsync_end = he, m.htotal = ht;
    m.vdisplay = h, m.vsync_start = vs, m.vsync_end = ve, m.vtotal = vt;
    m.vrefresh = 60;
    m.flags = DRM_MODE_FLAG_PHSYNC | DRM_MODE_FLAG_PVSYNC;
    m.type = DRM_MODE_TYPE_DRIVER | type;
    snprintf(m.name, sizeof(m.name), "%dx%d", w, h);
    return m;
}

static int dpi(void) {
    const char* c = getenv("FAKEDRM_CONNECTOR");
    return c && !strcmp(c, "DPI-1");
}

static int dsi(void) {
    const char* c = getenv("FAKEDRM_CONNECTOR");
    return c && !strcmp(c, "DSI-1");
}

// The connector's modes, the preferred first; returns how many.
static int modes(drmModeModeInfo out[2]) {
    if (dpi()) {
        out[0] = mode(1920, 997, 38400, 1920, 1921, 1921, 998, 999, 1000, DRM_MODE_TYPE_PREFERRED);
        out[0].vrefresh = 20;
        return 1;
    }
    if (dsi()) {
        out[0] = mode(800, 480, 30000, 840, 860, 1000, 488, 490, 500, DRM_MODE_TYPE_PREFERRED);
        return 1;
    }
    const char* preferred = getenv("FAKEDRM_PREFERRED");
    if (preferred && !strcmp(preferred, "1280x800")) {
        out[0] = mode(1280, 800, 83500, 1352, 1480, 1680, 803, 809, 831, DRM_MODE_TYPE_PREFERRED);
    } else {
        out[0] = mode(1920, 1080, 148500, 2008, 2052, 2200, 1084, 1089, 1125, DRM_MODE_TYPE_PREFERRED);
    }
    out[1] = mode(1280, 720, 74250, 1390, 1430, 1650, 725, 730, 750, 0);
    return 2;
}

// The console left the CRTC running the preferred mode.
__attribute__((constructor)) static void init(void) {
    drmModeModeInfo m[2];
    modes(m);
    crtc_mode = m[0];
    const char* off = getenv("FAKEDRM_CRTC_OFF");
    if (off && !strcmp(off, "1")) {
        crtc_active = 0;
    }
}

/* --- the real libc functions --------------------------------------------- */

#define REAL(name) \
    static __typeof__(&name) real_##name; \
    if (!real_##name) real_##name = (__typeof__(&name))dlsym(RTLD_NEXT, #name)

static void logf_(const char* fmt, ...) {
    const char* path = getenv("FAKEDRM_LOG");
    if (!path) {
        return;
    }
    REAL(fopen);
    FILE* f = real_fopen(path, "a");
    if (!f) {
        return;
    }
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

static uint64_t now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + ts.tv_nsec / 1000;
}

static uint64_t period_us(void) {
    return 1000000ULL / (crtc_mode.vrefresh ? crtc_mode.vrefresh : 60);
}

/* --- fds ------------------------------------------------------------------ */

// Caller holds mu.
static int is_ours_locked(int fd) {
    for (int i = 0; i < nfiles; i++) {
        if (files[i] == fd) {
            return 1;
        }
    }
    return 0;
}

static int is_ours(int fd) {
    if (fd < 0) {
        return 0;
    }
    pthread_mutex_lock(&mu);
    int r = is_ours_locked(fd);
    pthread_mutex_unlock(&mu);
    return r;
}

static int new_file(int cloexec) {
    int fd = eventfd(0, EFD_NONBLOCK | (cloexec ? EFD_CLOEXEC : 0));
    if (fd < 0) {
        return -1;
    }
    pthread_mutex_lock(&mu);
    if (nfiles < MAXFILES) {
        files[nfiles++] = fd;
    }
    pthread_mutex_unlock(&mu);
    return fd;
}

/* --- paths ---------------------------------------------------------------- */

// 0: not ours. 1: the card. -1: a path under /dev/dri or /sys/class/drm that
// doesn't exist here. 2: a sysfs file, at `mapped`.
static int classify(const char* path, char* mapped, size_t len) {
    if (!path) {
        return 0;
    }
    if (!strncmp(path, "/dev/dri/", 9)) {
        return strcmp(path, CARD) ? -1 : 1;
    }
    if (!strncmp(path, SYSFS, strlen(SYSFS))) {
        const char* dir = getenv("FAKEDRM_DIR");
        if (!dir) {
            return -1;
        }
        snprintf(mapped, len, "%s/sys/class/drm/%s", dir, path + strlen(SYSFS));
        return 2;
    }
    return 0;
}

static int open_common(const char* path, int flags, mode_t m, int (*real)(const char*, int, ...)) {
    char mapped[4096];
    switch (classify(path, mapped, sizeof(mapped))) {
    case 1: return new_file(flags & O_CLOEXEC);
    case -1: errno = ENOENT; return -1;
    case 2: return real(mapped, flags, m);
    default: return real(path, flags, m);
    }
}

int open(const char* path, int flags, ...) {
    REAL(open);
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        m = va_arg(ap, mode_t);
        va_end(ap);
    }
    return open_common(path, flags, m, real_open);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        m = va_arg(ap, mode_t);
        va_end(ap);
    }
    return open_common(path, flags, m, real_open64);
}

int openat(int dirfd, const char* path, int flags, ...) {
    REAL(openat);
    mode_t m = 0;
    if (flags & (O_CREAT | O_TMPFILE)) {
        va_list ap;
        va_start(ap, flags);
        m = va_arg(ap, mode_t);
        va_end(ap);
    }
    char mapped[4096];
    switch (path[0] == '/' ? classify(path, mapped, sizeof(mapped)) : 0) {
    case 1: return new_file(flags & O_CLOEXEC);
    case -1: errno = ENOENT; return -1;
    case 2: return real_openat(dirfd, mapped, flags, m);
    default: return real_openat(dirfd, path, flags, m);
    }
}

static FILE* fopen_common(const char* path, const char* how, FILE* (*real)(const char*, const char*)) {
    char mapped[4096];
    switch (classify(path, mapped, sizeof(mapped))) {
    case 1:
    case -1: errno = ENOENT; return NULL;
    case 2: return real(mapped, how);
    default: return real(path, how);
    }
}

FILE* fopen(const char* path, const char* how) {
    REAL(fopen);
    return fopen_common(path, how, real_fopen);
}

FILE* fopen64(const char* path, const char* how) {
    REAL(fopen64);
    return fopen_common(path, how, real_fopen64);
}

static int stat_card(struct stat* st) {
    memset(st, 0, sizeof(*st));
    st->st_mode = S_IFCHR | 0660;
    st->st_rdev = makedev(226, 0);
    return 0;
}

int stat(const char* path, struct stat* st) {
    REAL(stat);
    char mapped[4096];
    switch (classify(path, mapped, sizeof(mapped))) {
    case 1: return stat_card(st);
    case -1: errno = ENOENT; return -1;
    case 2: return real_stat(mapped, st);
    default: return real_stat(path, st);
    }
}

int stat64(const char* path, struct stat64* st) {
    REAL(stat64);
    char mapped[4096];
    switch (classify(path, mapped, sizeof(mapped))) {
    case 1: return stat_card((struct stat*)st);
    case -1: errno = ENOENT; return -1;
    case 2: return real_stat64(mapped, st);
    default: return real_stat64(path, st);
    }
}

int access(const char* path, int how) {
    REAL(access);
    char mapped[4096];
    switch (classify(path, mapped, sizeof(mapped))) {
    case 1: return 0;
    case -1: errno = ENOENT; return -1;
    case 2: return real_access(mapped, how);
    default: return real_access(path, how);
    }
}

/* --- planes and the load limit -------------------------------------------- */

static Fb* fb_locked(uint32_t id) {
    for (int i = 0; i < MAXFBS; i++) {
        if (fbs[i].id && fbs[i].id == id) {
            return &fbs[i];
        }
    }
    return NULL;
}

static Plane* plane_locked(uint32_t id) {
    for (int i = 0; i < NPLANES; i++) {
        if (planes[i].id == id) {
            return &planes[i];
        }
    }
    return NULL;
}

// Buffer planes, and per buffer plane its subsampling and bytes per pixel.
static int layout(uint32_t format, int sub[3], int cpp[3]) {
    switch (format) {
    case DRM_FORMAT_YUV420:
    case DRM_FORMAT_YVU420:
        sub[0] = 1, sub[1] = sub[2] = 2;
        cpp[0] = cpp[1] = cpp[2] = 1;
        return 3;
    case DRM_FORMAT_NV12:
    case DRM_FORMAT_NV21:
        sub[0] = 1, sub[1] = 2;
        cpp[0] = 1, cpp[1] = 2;
        return 2;
    case DRM_FORMAT_RGB565: sub[0] = 1, cpp[0] = 2; return 1;
    case DRM_FORMAT_RGB888:
    case DRM_FORMAT_BGR888: sub[0] = 1, cpp[0] = 3; return 1;
    default: sub[0] = 1, cpp[0] = 4; return 1;
    }
}

// The load of every enabled plane, with `with` standing in for the plane of
// its id.  Caller holds mu.
static void load_locked(const Plane* with, uint64_t* hvs, uint64_t* membus) {
    *hvs = *membus = 0;
    if (!crtc_active) {
        return;
    }
    uint64_t vrefresh = crtc_mode.vrefresh ? crtc_mode.vrefresh : 60;
    for (int i = 0; i < NPLANES; i++) {
        const Plane* p = (with && with->id == planes[i].id) ? with : &planes[i];
        Fb* fb = p->fb ? fb_locked(p->fb) : NULL;
        if (!p->crtc || !fb || !p->cw || !p->ch) {
            continue;
        }
        int sub[3], cpp[3];
        int n = layout(fb->format, sub, cpp);
        uint32_t sw = p->sw >> 16, sh = p->sh >> 16;
        int scaled = n > 1 || sw != p->cw || sh != p->ch;
        *hvs += ((uint64_t)n * p->cw * p->ch * vrefresh) >> (scaled ? 1 : 2);
        for (int k = 0; k < n; k++) {
            uint64_t w = sw / sub[k], h = sh / sub[k];
            uint64_t vscale = (h + p->ch - 1) / p->ch;
            *membus += w * h * vscale * cpp[k] * vrefresh;
        }
    }
}

static int over_limit_locked(const Plane* with, uint64_t* hvs) {
    uint64_t membus;
    load_locked(with, hvs, &membus);
    const char* tracker = getenv("FAKEDRM_LOAD_TRACKER");
    if (tracker && !strcmp(tracker, "0")) {
        return 0;
    }
    return *hvs > HVS_LIMIT || membus > MEMBUS_LIMIT;
}

static const char* fourcc(uint32_t f, char out[5]) {
    for (int i = 0; i < 4; i++) {
        out[i] = (char)((f >> (8 * i)) & 0xff);
    }
    out[4] = 0;
    return out;
}

static void disable_plane_locked(Plane* p, const char* why) {
    if (p->crtc || p->fb) {
        logf_("disable %u (%s)", p->id, why);
    }
    p->crtc = p->fb = 0;
    p->cx = p->cy = 0;
    p->cw = p->ch = p->sx = p->sy = p->sw = p->sh = 0;
}

// The kernel takes a framebuffer off every plane showing it when it goes.
static void remove_fb_locked(Fb* fb, const char* why) {
    for (int i = 0; i < NPLANES; i++) {
        if (planes[i].fb == fb->id) {
            disable_plane_locked(&planes[i], why);
        }
    }
    memset(fb, 0, sizeof(*fb));
}

int drmModeSetPlane(int fd, uint32_t plane_id, uint32_t crtc_id, uint32_t fb_id, uint32_t flags,
                    int32_t crtc_x, int32_t crtc_y, uint32_t crtc_w, uint32_t crtc_h,
                    uint32_t src_x, uint32_t src_y, uint32_t src_w, uint32_t src_h) {
    (void)flags;
    pthread_mutex_lock(&mu);
    Plane* p = plane_locked(plane_id);
    if (!is_ours_locked(fd) || !p) {
        pthread_mutex_unlock(&mu);
        errno = p ? EBADF : ENOENT;
        return -1;
    }
    if (!fb_id) {
        disable_plane_locked(p, "fb 0");
        pthread_mutex_unlock(&mu);
        return 0;
    }
    Fb* fb = fb_locked(fb_id);
    if (!fb || crtc_id != CRTC_ID || !crtc_active || !crtc_w || !crtc_h ||
        ((uint64_t)src_x + src_w) >> 16 > fb->w || ((uint64_t)src_y + src_h) >> 16 > fb->h) {
        pthread_mutex_unlock(&mu);
        errno = fb ? EINVAL : ENOENT;
        return -1;
    }
    Plane next = { p->id, p->type, crtc_id, fb_id, crtc_x, crtc_y, crtc_w, crtc_h, src_x, src_y, src_w, src_h };
    uint64_t hvs;
    char f[5];
    const char* refuse = getenv("FAKEDRM_REFUSE_PLANES");
    if (refuse && !strcmp(refuse, "1")) {
        logf_("refuse %u src %ux%u: ENOSPC (FAKEDRM_REFUSE_PLANES)", plane_id, src_w >> 16, src_h >> 16);
        pthread_mutex_unlock(&mu);
        errno = ENOSPC;
        return -1;
    }
    if (over_limit_locked(&next, &hvs)) {
        logf_("refuse %u %s %ux%u+%d+%d src %ux%u hvs %llu: ENOSPC", plane_id, fourcc(fb->format, f),
              crtc_w, crtc_h, crtc_x, crtc_y, src_w >> 16, src_h >> 16, (unsigned long long)hvs);
        pthread_mutex_unlock(&mu);
        errno = ENOSPC;
        return -1;
    }
    int changed = p->crtc != next.crtc || p->cw != next.cw || p->ch != next.ch || p->cx != next.cx ||
                  p->cy != next.cy || p->sw != next.sw || p->sh != next.sh ||
                  !p->fb || fb_locked(p->fb) == NULL || fb_locked(p->fb)->format != fb->format;
    *p = next;
    if (changed) {
        logf_("plane %u %s %ux%u+%d+%d src %ux%u hvs %llu", plane_id, fourcc(fb->format, f),
              crtc_w, crtc_h, crtc_x, crtc_y, src_w >> 16, src_h >> 16, (unsigned long long)hvs);
    }
    pthread_mutex_unlock(&mu);
    return 0;
}

int drmModeSetCrtc(int fd, uint32_t crtc_id, uint32_t fb_id, uint32_t x, uint32_t y,
                   uint32_t* connectors, int count, drmModeModeInfoPtr m) {
    (void)connectors;
    (void)count;
    pthread_mutex_lock(&mu);
    if (!is_ours_locked(fd) || crtc_id != CRTC_ID) {
        pthread_mutex_unlock(&mu);
        errno = EINVAL;
        return -1;
    }
    if (!fb_id || !m) {
        for (int i = 0; i < NPLANES; i++) {
            disable_plane_locked(&planes[i], "crtc off");
        }
        crtc_active = 0;
        logf_("crtc off");
        pthread_mutex_unlock(&mu);
        return 0;
    }
    const char* failing = getenv("FAKEDRM_FAIL_MODESET");
    if (failing) {
        REAL(access);
        if (real_access(failing, F_OK) == 0) {
            logf_("refuse crtc %dx%d@%d: FAKEDRM_FAIL_MODESET", m->hdisplay, m->vdisplay, m->vrefresh);
            pthread_mutex_unlock(&mu);
            errno = EBUSY;
            return -1;
        }
    }
    Fb* fb = fb_locked(fb_id);
    // Legacy SetCrtc scans the primary plane out at the mode's size.
    if (!fb || fb->w < x + m->hdisplay || fb->h < y + m->vdisplay) {
        pthread_mutex_unlock(&mu);
        errno = fb ? ENOSPC : ENOENT;
        return -1;
    }
    Plane next = planes[0];
    next.crtc = crtc_id, next.fb = fb_id;
    next.cx = next.cy = 0, next.cw = m->hdisplay, next.ch = m->vdisplay;
    next.sx = x << 16, next.sy = y << 16, next.sw = (uint32_t)m->hdisplay << 16, next.sh = (uint32_t)m->vdisplay << 16;
    int wasActive = crtc_active;
    drmModeModeInfo was = crtc_mode;
    crtc_active = 1;
    crtc_mode = *m;
    uint64_t hvs;
    if (over_limit_locked(&next, &hvs)) {
        crtc_active = wasActive;
        crtc_mode = was;
        logf_("refuse crtc hvs %llu: ENOSPC", (unsigned long long)hvs);
        pthread_mutex_unlock(&mu);
        errno = ENOSPC;
        return -1;
    }
    planes[0] = next;
    logf_("crtc %dx%d@%d primary fb %u", m->hdisplay, m->vdisplay, m->vrefresh, fb_id);
    pthread_mutex_unlock(&mu);
    return 0;
}

/* --- events --------------------------------------------------------------- */

static void* timer(void* arg) {
    (void)arg;
    pthread_mutex_lock(&mu);
    for (;;) {
        uint64_t next = 0;
        for (int i = 0; i < nevents; i++) {
            if (!events[i].signalled && (!next || events[i].due_us < next)) {
                next = events[i].due_us;
            }
        }
        if (!next) {
            pthread_cond_wait(&cv, &mu);
            continue;
        }
        uint64_t now = now_us();
        if (now < next) {
            struct timespec ts;
            clock_gettime(CLOCK_MONOTONIC, &ts);
            uint64_t ns = (uint64_t)ts.tv_nsec + (next - now) * 1000ULL;
            ts.tv_sec += ns / 1000000000ULL;
            ts.tv_nsec = ns % 1000000000ULL;
            pthread_cond_timedwait(&cv, &mu, &ts);
            continue;
        }
        for (int i = 0; i < nevents; i++) {
            if (!events[i].signalled && events[i].due_us <= now) {
                events[i].signalled = 1;
                if (events[i].flip) {
                    flip_pending = 0;
                }
                uint64_t one = 1;
                ssize_t w = write(events[i].fd, &one, sizeof(one));
                (void)w;
            }
        }
    }
    return NULL;
}

// The next vblank, as the kernel would report it.  Caller holds mu.
static int queue_locked(int fd, int flip, void* data, uint64_t* due) {
    if (nevents >= MAXEVENTS) {
        return -1;
    }
    uint64_t p = period_us();
    uint64_t at = (now_us() / p + 1) * p;
    events[nevents++] = (Event){ fd, 0, flip, at, (uint32_t)(at / p), data };
    if (due) {
        *due = at;
    }
    if (!timer_started) {
        pthread_condattr_t ca;
        pthread_condattr_init(&ca);
        pthread_condattr_setclock(&ca, CLOCK_MONOTONIC);
        pthread_cond_destroy(&cv);
        pthread_cond_init(&cv, &ca);
        pthread_t t;
        pthread_create(&t, NULL, timer, NULL);
        pthread_detach(t);
        timer_started = 1;
    }
    pthread_cond_signal(&cv);
    return 0;
}

int drmModePageFlip(int fd, uint32_t crtc_id, uint32_t fb_id, uint32_t flags, void* data) {
    pthread_mutex_lock(&mu);
    Fb* fb = fb_locked(fb_id);
    if (!is_ours_locked(fd) || crtc_id != CRTC_ID || !crtc_active || !fb || !planes[0].fb) {
        pthread_mutex_unlock(&mu);
        errno = EINVAL;
        return -1;
    }
    if (flip_pending) {
        pthread_mutex_unlock(&mu);
        errno = EBUSY;
        return -1;
    }
    planes[0].fb = fb_id;
    if (flags & DRM_MODE_PAGE_FLIP_EVENT) {
        flip_pending = 1;
        queue_locked(fd, 1, data, NULL);
    }
    pthread_mutex_unlock(&mu);
    return 0;
}

int drmWaitVBlank(int fd, drmVBlankPtr vbl) {
    pthread_mutex_lock(&mu);
    if (!is_ours_locked(fd)) {
        pthread_mutex_unlock(&mu);
        errno = EBADF;
        return -1;
    }
    uint64_t due;
    if (vbl->request.type & DRM_VBLANK_EVENT) {
        queue_locked(fd, 0, (void*)vbl->request.signal, &due);
        pthread_mutex_unlock(&mu);
    } else {
        uint64_t p = period_us();
        due = (now_us() / p + 1) * p;
        pthread_mutex_unlock(&mu);
        uint64_t now = now_us();
        if (due > now) {
            usleep((useconds_t)(due - now));
        }
    }
    vbl->reply.sequence = (unsigned int)(due / period_us());
    vbl->reply.tval_sec = (long)(due / 1000000ULL);
    vbl->reply.tval_usec = (long)(due % 1000000ULL);
    return 0;
}

int drmHandleEvent(int fd, drmEventContextPtr ctx) {
    uint64_t count;
    ssize_t r = read(fd, &count, sizeof(count));
    (void)r;
    Event due[MAXEVENTS];
    int n = 0;
    pthread_mutex_lock(&mu);
    for (int i = 0; i < nevents;) {
        if (events[i].fd == fd && events[i].signalled) {
            due[n++] = events[i];
            events[i] = events[--nevents];
        } else {
            i++;
        }
    }
    pthread_mutex_unlock(&mu);
    for (int i = 0; i < n; i++) {
        unsigned int sec = (unsigned int)(due[i].due_us / 1000000ULL);
        unsigned int usec = (unsigned int)(due[i].due_us % 1000000ULL);
        if (due[i].flip && ctx->page_flip_handler) {
            ctx->page_flip_handler(fd, due[i].seq, sec, usec, due[i].data);
        } else if (!due[i].flip && ctx->vblank_handler) {
            ctx->vblank_handler(fd, due[i].seq, sec, usec, due[i].data);
        }
    }
    return 0;
}

/* --- buffers -------------------------------------------------------------- */

int drmIoctl(int fd, unsigned long request, void* arg) {
    if (!is_ours(fd)) {
        REAL(drmIoctl);
        return real_drmIoctl(fd, request, arg);
    }
    switch (request) {
    case DRM_IOCTL_MODE_CREATE_DUMB: {
        struct drm_mode_create_dumb* c = arg;
        c->pitch = ((c->width * ((c->bpp + 7) / 8)) + 63) & ~63u;
        c->size = (uint64_t)c->pitch * c->height;
        pthread_mutex_lock(&mu);
        c->handle = ++next_handle;
        pthread_mutex_unlock(&mu);
        return 0;
    }
    case DRM_IOCTL_MODE_MAP_DUMB: {
        struct drm_mode_map_dumb* m = arg;
        m->offset = (uint64_t)m->handle << 12;
        return 0;
    }
    case DRM_IOCTL_MODE_DESTROY_DUMB:
    case DRM_IOCTL_SET_MASTER:
    case DRM_IOCTL_DROP_MASTER:
        return 0;
    default:
        errno = EINVAL;
        return -1;
    }
}

int ioctl(int fd, unsigned long request, ...) {
    va_list ap;
    va_start(ap, request);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    if (is_ours(fd)) {
        return drmIoctl(fd, request, arg);
    }
    REAL(ioctl);
    return real_ioctl(fd, request, arg);
}

void* mmap(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    REAL(mmap);
    if (is_ours(fd)) {
        // A dumb buffer: memory nothing else reads.
        return real_mmap(addr, len, prot, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    }
    return real_mmap(addr, len, prot, flags, fd, off);
}

void* mmap64(void* addr, size_t len, int prot, int flags, int fd, off64_t off) {
    REAL(mmap64);
    if (is_ours(fd)) {
        return real_mmap64(addr, len, prot, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    }
    return real_mmap64(addr, len, prot, flags, fd, off);
}

int drmModeAddFB2(int fd, uint32_t w, uint32_t h, uint32_t format, const uint32_t handles[4],
                  const uint32_t pitches[4], const uint32_t offsets[4], uint32_t* id, uint32_t flags) {
    (void)handles;
    (void)pitches;
    (void)offsets;
    (void)flags;
    pthread_mutex_lock(&mu);
    if (!is_ours_locked(fd)) {
        pthread_mutex_unlock(&mu);
        errno = EBADF;
        return -1;
    }
    for (int i = 0; i < MAXFBS; i++) {
        if (!fbs[i].id) {
            fbs[i] = (Fb){ next_fb++, w, h, format, fd };
            *id = fbs[i].id;
            pthread_mutex_unlock(&mu);
            return 0;
        }
    }
    pthread_mutex_unlock(&mu);
    errno = ENOMEM;
    return -1;
}

int drmModeRmFB(int fd, uint32_t id) {
    (void)fd;
    pthread_mutex_lock(&mu);
    Fb* fb = fb_locked(id);
    if (fb) {
        remove_fb_locked(fb, "fb removed");
    }
    pthread_mutex_unlock(&mu);
    if (!fb) {
        errno = ENOENT;
        return -1;
    }
    return 0;
}

int close(int fd) {
    REAL(close);
    pthread_mutex_lock(&mu);
    if (is_ours_locked(fd)) {
        // Closing a card fd or a lease removes the framebuffers added on it,
        // and takes them off the screen.
        for (int i = 0; i < MAXFBS; i++) {
            if (fbs[i].id && fbs[i].owner == fd) {
                remove_fb_locked(&fbs[i], "its fd closed");
            }
        }
        for (int i = 0; i < nevents;) {
            if (events[i].fd == fd) {
                if (events[i].flip && !events[i].signalled) {
                    flip_pending = 0;
                }
                events[i] = events[--nevents];
            } else {
                i++;
            }
        }
        for (int i = 0; i < nfiles; i++) {
            if (files[i] == fd) {
                files[i] = files[--nfiles];
                break;
            }
        }
    }
    pthread_mutex_unlock(&mu);
    return real_close(fd);
}

int drmModeCreateLease(int fd, const uint32_t* objects, int count, int flags, uint32_t* lessee_id) {
    if (!is_ours(fd)) {
        errno = EBADF;
        return -1;
    }
    int lfd = new_file(flags & O_CLOEXEC);
    if (lfd < 0) {
        return -1;
    }
    pthread_mutex_lock(&mu);
    *lessee_id = ++next_lessee;
    pthread_mutex_unlock(&mu);
    logf_("lease %u: %d objects", *lessee_id, count);
    (void)objects;
    return lfd;
}

int drmSetClientCap(int fd, uint64_t capability, uint64_t value) {
    (void)capability;
    (void)value;
    if (is_ours(fd)) {
        return 0;
    }
    REAL(drmSetClientCap);
    return real_drmSetClientCap(fd, capability, value);
}

/* --- what's on the card --------------------------------------------------- */

drmModeResPtr drmModeGetResources(int fd) {
    if (!is_ours(fd)) {
        errno = EBADF;
        return NULL;
    }
    drmModeResPtr r = calloc(1, sizeof(*r));
    r->count_crtcs = r->count_connectors = r->count_encoders = 1;
    r->crtcs = malloc(sizeof(uint32_t));
    r->crtcs[0] = CRTC_ID;
    r->connectors = malloc(sizeof(uint32_t));
    r->connectors[0] = CONN_ID;
    r->encoders = malloc(sizeof(uint32_t));
    r->encoders[0] = ENC_ID;
    r->max_width = r->max_height = 2048;
    return r;
}

static drmModeConnectorPtr connector(int fd, uint32_t id) {
    if (!is_ours(fd) || id != CONN_ID) {
        errno = ENOENT;
        return NULL;
    }
    drmModeConnectorPtr c = calloc(1, sizeof(*c));
    c->connector_id = CONN_ID;
    c->encoder_id = ENC_ID;
    c->connector_type = dpi() ? DRM_MODE_CONNECTOR_DPI : dsi() ? DRM_MODE_CONNECTOR_DSI : DRM_MODE_CONNECTOR_HDMIA;
    c->connector_type_id = 1;
    c->connection = DRM_MODE_CONNECTED;
    c->mmWidth = 520, c->mmHeight = 290;
    const char* mm = getenv("FAKEDRM_MM");
    if (mm) {
        sscanf(mm, "%ux%u", &c->mmWidth, &c->mmHeight);
    }
    c->subpixel = DRM_MODE_SUBPIXEL_UNKNOWN;
    c->modes = malloc(2 * sizeof(drmModeModeInfo));
    c->count_modes = modes(c->modes);
    c->count_props = 1;
    c->props = malloc(sizeof(uint32_t));
    c->props[0] = PROP_EDID;
    c->prop_values = malloc(sizeof(uint64_t));
    c->prop_values[0] = EDID_BLOB;
    c->count_encoders = 1;
    c->encoders = malloc(sizeof(uint32_t));
    c->encoders[0] = ENC_ID;
    return c;
}

drmModeConnectorPtr drmModeGetConnector(int fd, uint32_t id) {
    return connector(fd, id);
}

drmModeConnectorPtr drmModeGetConnectorCurrent(int fd, uint32_t id) {
    return connector(fd, id);
}

drmModeEncoderPtr drmModeGetEncoder(int fd, uint32_t id) {
    if (!is_ours(fd) || id != ENC_ID) {
        errno = ENOENT;
        return NULL;
    }
    drmModeEncoderPtr e = calloc(1, sizeof(*e));
    e->encoder_id = ENC_ID;
    e->encoder_type = dpi() ? DRM_MODE_ENCODER_DPI : dsi() ? DRM_MODE_ENCODER_DSI : DRM_MODE_ENCODER_TMDS;
    pthread_mutex_lock(&mu);
    e->crtc_id = crtc_active ? CRTC_ID : 0;
    pthread_mutex_unlock(&mu);
    e->possible_crtcs = 1;
    return e;
}

// The CRTC and the mode it runs, for whoever asks what the display is doing
// (kmssink does, and fppd's aspect check).
drmModeCrtcPtr drmModeGetCrtc(int fd, uint32_t id) {
    if (!is_ours(fd) || id != CRTC_ID) {
        errno = ENOENT;
        return NULL;
    }
    drmModeCrtcPtr c = calloc(1, sizeof(*c));
    c->crtc_id = CRTC_ID;
    pthread_mutex_lock(&mu);
    if (crtc_active) {
        c->mode = crtc_mode;
        c->mode_valid = 1;
        c->width = crtc_mode.hdisplay;
        c->height = crtc_mode.vdisplay;
    }
    pthread_mutex_unlock(&mu);
    return c;
}

drmModePlaneResPtr drmModeGetPlaneResources(int fd) {
    if (!is_ours(fd)) {
        errno = EBADF;
        return NULL;
    }
    drmModePlaneResPtr r = calloc(1, sizeof(*r));
    r->count_planes = NPLANES;
    r->planes = malloc(NPLANES * sizeof(uint32_t));
    for (int i = 0; i < NPLANES; i++) {
        r->planes[i] = planes[i].id;
    }
    return r;
}

drmModePlanePtr drmModeGetPlane(int fd, uint32_t id) {
    pthread_mutex_lock(&mu);
    Plane* p = plane_locked(id);
    if (!is_ours_locked(fd) || !p) {
        pthread_mutex_unlock(&mu);
        errno = ENOENT;
        return NULL;
    }
    drmModePlanePtr r = calloc(1, sizeof(*r));
    r->plane_id = p->id;
    r->crtc_id = p->crtc;
    r->fb_id = p->fb;
    r->crtc_x = (uint32_t)p->cx, r->crtc_y = (uint32_t)p->cy;
    r->possible_crtcs = 1;
    pthread_mutex_unlock(&mu);
    r->count_formats = NFORMATS;
    r->formats = malloc(sizeof(FORMATS));
    memcpy(r->formats, FORMATS, sizeof(FORMATS));
    return r;
}

drmModeObjectPropertiesPtr drmModeObjectGetProperties(int fd, uint32_t id, uint32_t type) {
    if (!is_ours(fd)) {
        errno = EBADF;
        return NULL;
    }
    drmModeObjectPropertiesPtr r = calloc(1, sizeof(*r));
    pthread_mutex_lock(&mu);
    Plane* p = type == DRM_MODE_OBJECT_PLANE ? plane_locked(id) : NULL;
    if (p) {
        r->count_props = 1;
        r->props = malloc(sizeof(uint32_t));
        r->props[0] = PROP_TYPE;
        r->prop_values = malloc(sizeof(uint64_t));
        r->prop_values[0] = (uint64_t)p->type;
    } else if (type == DRM_MODE_OBJECT_CONNECTOR && id == CONN_ID) {
        r->count_props = 1;
        r->props = malloc(sizeof(uint32_t));
        r->props[0] = PROP_EDID;
        r->prop_values = malloc(sizeof(uint64_t));
        r->prop_values[0] = EDID_BLOB;
    }
    pthread_mutex_unlock(&mu);
    return r;
}

drmModePropertyPtr drmModeGetProperty(int fd, uint32_t id) {
    if (!is_ours(fd) || (id != PROP_EDID && id != PROP_TYPE)) {
        errno = ENOENT;
        return NULL;
    }
    drmModePropertyPtr r = calloc(1, sizeof(*r));
    r->prop_id = id;
    if (id == PROP_EDID) {
        snprintf(r->name, sizeof(r->name), "EDID");
        r->flags = DRM_MODE_PROP_BLOB | DRM_MODE_PROP_IMMUTABLE;
    } else {
        snprintf(r->name, sizeof(r->name), "type");
        r->flags = DRM_MODE_PROP_ENUM | DRM_MODE_PROP_IMMUTABLE;
    }
    return r;
}
