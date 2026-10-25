/* fakepruss.so: LD_PRELOAD into fppd on an AM335x BeagleBone (BBB,
 * PocketBeagle) to give its PRU outputs a PRU subsystem that never runs a
 * program but keeps a record of everything done to it.  An AM335x fppd has
 * no FAKE_PRU mode of its own: under run-local.sh /dev/mem is /dev/null and
 * every PRU output fails to start.  With this, Init, PrepData, SendData,
 * Close and the PRU loader (BBBPruUtils) run in full:
 *
 *   - /dev/mem: the PRUSS window (0x4a300000, 256K) and the PRU DDR region
 *     (0x8f000000, 4M) are mapped from the files pruss and ddr in
 *     $FAKEPRUSS_DIR, so a scenario reads what fppd wrote to the PRU data
 *     and shared RAM and to the frame buffers in DDR.  Any other offset fails.
 *   - remoteproc: a write of "start"/"stop" to
 *     /sys/class/remoteproc/remoteprocN/state is acted on here (the scenario
 *     makes those files in run-local.sh's empty /sys/class/remoteproc): the
 *     state file goes to running/offline, the core's CONTROL register (0x22000
 *     + N*0x2000 in the window) gets EN and RUNSTATE set or EN cleared, and a
 *     start copies the program /lib/firmware/<the firmware file> resolves to
 *     into fwN.<count>, as remoteproc would load it.
 *   - the core: a thread stands in for the firmware.  A core whose EN is
 *     cleared halts (RUNSTATE drops) -- unless $FAKEPRUSS_UNDO is set: then
 *     the first that many clears after each start are undone, as a running
 *     program's RESET_PRU_CLOCK read-modify-write of CONTROL undoes a clear
 *     that lands between its read and its write.
 *   - $FAKEPRUSS_OFFLINE_FAULT: the PRUSS RAM pages of fppd's mapping (data
 *     RAM 0/1, shared RAM) are made inaccessible while remoteproc has every
 *     core offline ("all"), or any core offline ("any"), as the PRUSS's RAM
 *     can be once a core is stopped (on the hardware the access takes an
 *     external abort, SIGBUS; here it is a SIGSEGV).  The CONTROL registers
 *     stay reachable.
 *
 * Every event is a line in $FAKEPRUSS_DIR/events: "start N <firmware> <copy>",
 * "stop N", "undone N", "halted N", "loaded-running N" (a start while the core
 * had never halted), "map pruss|ddr|bad 0x<off>".
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define PRUSS_BASE 0x4a300000u
#define PRUSS_SIZE 0x40000u
#define DDR_BASE 0x8f000000u
#define DDR_SIZE 0x400000u
#define CTRL_OFF 0x22000u
#define CTRL_STRIDE 0x2000u
#define CTRL_EN 0x2u
#define CTRL_RUNSTATE 0x8000u

#define REAL(name) \
    static __typeof__(name)* real_##name; \
    if (!real_##name) real_##name = (__typeof__(name)*)dlsym(RTLD_NEXT, #name)

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int memfds[64];
static int nmemfds;
static volatile uint32_t* view;       /* our own map of the pruss file */
static uint8_t* fppd_pruss;           /* fppd's map of it, for the fault model */
static int online[2];                 /* remoteproc's idea of each core */
static int running[2];                /* whether the "firmware" runs */
static int undo_left[2];
static int fwcount;
static int ready;

static const char* dir(void) {
    const char* d = getenv("FAKEPRUSS_DIR");
    return d ? d : "/tmp/fakepruss";
}

static void event(const char* fmt, ...) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/events", dir());
    REAL(fopen);
    FILE* f = real_fopen(path, "a");
    if (!f) return;
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

/* close() is interposed (to forget /dev/mem fds) and takes the lock */
static int rclose(int fd) {
    REAL(close);
    return real_close(fd);
}

static int open_backing(const char* name, size_t size) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "%s/%s", dir(), name);
    REAL(open);
    int fd = real_open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0644);
    if (fd < 0) return -1;
    struct stat st;
    if (fstat(fd, &st) == 0 && (size_t)st.st_size < size && ftruncate(fd, size) != 0) {
        rclose(fd);
        return -1;
    }
    return fd;
}

static volatile uint32_t* ctrl(int n) {
    return (volatile uint32_t*)((volatile uint8_t*)view + CTRL_OFF + n * CTRL_STRIDE);
}

static void state_file(int n, const char* state) {
    char path[PATH_MAX];
    snprintf(path, sizeof(path), "/sys/class/remoteproc/remoteproc%d/state", n);
    REAL(fopen);
    FILE* f = real_fopen(path, "w");
    if (f) {
        fprintf(f, "%s\n", state);
        fclose(f);
    }
}

static void apply_reachability(void) {
    const char* model = getenv("FAKEPRUSS_OFFLINE_FAULT");
    if (!fppd_pruss || !model || !*model) return;
    int reachable = strcmp(model, "any") == 0 ? (online[0] && online[1]) : (online[0] || online[1]);
    int prot = reachable ? (PROT_READ | PROT_WRITE) : PROT_NONE;
    mprotect(fppd_pruss, 0x4000, prot);            /* data RAM 0 and 1 */
    mprotect(fppd_pruss + 0x10000, 0x3000, prot);  /* shared RAM */
}

static void* firmware_thread(void* arg) {
    (void)arg;
    struct timespec ts = { 0, 20000 };
    for (;;) {
        pthread_mutex_lock(&lock);
        for (int n = 0; n < 2; n++) {
            if (running[n] && !(*ctrl(n) & CTRL_EN)) {
                if (undo_left[n] > 0) {
                    undo_left[n]--;
                    *ctrl(n) |= CTRL_EN;
                    event("undone %d", n);
                } else {
                    *ctrl(n) &= ~CTRL_RUNSTATE;
                    running[n] = 0;
                    event("halted %d", n);
                }
            }
        }
        pthread_mutex_unlock(&lock);
        nanosleep(&ts, NULL);
    }
    return NULL;
}

/* First /dev/mem open: map our view, and take each core's state from the
 * state file the scenario wrote. */
static void setup(void) {
    if (ready) return;
    int fd = open_backing("pruss", PRUSS_SIZE);
    if (fd < 0) return;
    REAL(mmap);
    void* p = real_mmap(NULL, PRUSS_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    rclose(fd);
    if (p == MAP_FAILED) return;
    view = (volatile uint32_t*)p;
    for (int n = 0; n < 2; n++) {
        char path[PATH_MAX], buf[32] = "";
        snprintf(path, sizeof(path), "/sys/class/remoteproc/remoteproc%d/state", n);
        REAL(fopen);
        FILE* f = real_fopen(path, "r");
        if (f) {
            if (!fgets(buf, sizeof(buf), f)) buf[0] = 0;
            fclose(f);
        }
        online[n] = running[n] = strncmp(buf, "running", 7) == 0;
        if (running[n]) *ctrl(n) |= CTRL_EN | CTRL_RUNSTATE;
    }
    ready = 1;
    pthread_t t;
    pthread_create(&t, NULL, firmware_thread, NULL);
    pthread_detach(t);
}

static int is_memfd(int fd) {
    for (int i = 0; i < nmemfds; i++)
        if (memfds[i] == fd) return 1;
    return 0;
}

static int open_mem(void) {
    pthread_mutex_lock(&lock);
    setup();
    int fd = open_backing("pruss", PRUSS_SIZE);
    if (fd >= 0 && nmemfds < 64) memfds[nmemfds++] = fd;
    pthread_mutex_unlock(&lock);
    return fd;
}

static void* map_mem(void* addr, size_t len, int prot, int flags, uint64_t off) {
    REAL(mmap);
    const char* name = NULL;
    uint64_t rel = 0;
    size_t size = 0;
    if (off >= PRUSS_BASE && off + len <= PRUSS_BASE + PRUSS_SIZE) {
        name = "pruss", rel = off - PRUSS_BASE, size = PRUSS_SIZE;
    } else if (off >= DDR_BASE && off + len <= DDR_BASE + DDR_SIZE) {
        name = "ddr", rel = off - DDR_BASE, size = DDR_SIZE;
    }
    if (!name) {
        event("map bad 0x%llx", (unsigned long long)off);
        errno = EINVAL;
        return MAP_FAILED;
    }
    int fd = open_backing(name, size);
    if (fd < 0) return MAP_FAILED;
    void* p = real_mmap(addr, len, prot, flags, fd, (off_t)rel);
    rclose(fd);
    if (p != MAP_FAILED) {
        event("map %s 0x%llx", name, (unsigned long long)off);
        if (rel == 0 && size == PRUSS_SIZE) {
            pthread_mutex_lock(&lock);
            fppd_pruss = p;
            apply_reachability();
            pthread_mutex_unlock(&lock);
        }
    }
    return p;
}

void* mmap(void* addr, size_t len, int prot, int flags, int fd, off_t off) {
    REAL(mmap);
    if (fd >= 0 && is_memfd(fd)) return map_mem(addr, len, prot, flags, (uint64_t)(unsigned long)off);
    return real_mmap(addr, len, prot, flags, fd, off);
}

void* mmap64(void* addr, size_t len, int prot, int flags, int fd, off64_t off) {
    REAL(mmap64);
    if (fd >= 0 && is_memfd(fd)) return map_mem(addr, len, prot, flags, (uint64_t)off);
    return real_mmap64(addr, len, prot, flags, fd, off);
}

int close(int fd) {
    pthread_mutex_lock(&lock);
    for (int i = 0; i < nmemfds; i++) {
        if (memfds[i] == fd) {
            memfds[i] = memfds[--nmemfds];
            break;
        }
    }
    pthread_mutex_unlock(&lock);
    return rclose(fd);
}

static mode_t mode_arg(int flags, va_list ap) {
    return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(ap, int) : 0;
}

int open(const char* path, int flags, ...) {
    REAL(open);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    if (path && strcmp(path, "/dev/mem") == 0) return open_mem();
    return real_open(path, flags, mode);
}

int open64(const char* path, int flags, ...) {
    REAL(open64);
    va_list ap;
    va_start(ap, flags);
    mode_t mode = mode_arg(flags, ap);
    va_end(ap);
    if (path && strcmp(path, "/dev/mem") == 0) return open_mem();
    return real_open64(path, flags, mode);
}

int __open_2(const char* path, int flags) {
    REAL(__open_2);
    if (path && strcmp(path, "/dev/mem") == 0) return open_mem();
    return real___open_2(path, flags);
}

int __open64_2(const char* path, int flags) {
    REAL(__open64_2);
    if (path && strcmp(path, "/dev/mem") == 0) return open_mem();
    return real___open64_2(path, flags);
}

/* ---- remoteproc ------------------------------------------------------- */

static void copy_firmware(int n) {
    char path[PATH_MAX], name[128] = "", target[PATH_MAX], copy[PATH_MAX];
    snprintf(path, sizeof(path), "/sys/class/remoteproc/remoteproc%d/firmware", n);
    REAL(fopen);
    FILE* f = real_fopen(path, "r");
    if (f) {
        if (!fgets(name, sizeof(name), f)) name[0] = 0;
        fclose(f);
    }
    name[strcspn(name, " \r\n")] = 0;
    snprintf(path, sizeof(path), "/lib/firmware/%s", name);
    if (!realpath(path, target)) snprintf(target, sizeof(target), "(missing)");
    snprintf(copy, sizeof(copy), "%s/fw%d.%d", dir(), n, ++fwcount);
    FILE* in = real_fopen(path, "rb");
    FILE* out = in ? real_fopen(copy, "wb") : NULL;
    if (in && out) {
        char buf[4096];
        size_t r;
        while ((r = fread(buf, 1, sizeof(buf), in)) > 0) fwrite(buf, 1, r, out);
    }
    if (in) fclose(in);
    if (out) fclose(out);
    event("start %d %s %s", n, target, out ? copy : "-");
}

static void rproc_command(int n, const char* cmd) {
    pthread_mutex_lock(&lock);
    if (!ready) {
        pthread_mutex_unlock(&lock);
        return;
    }
    if (strncmp(cmd, "start", 5) == 0 && !online[n]) {
        if (*ctrl(n) & CTRL_RUNSTATE) event("loaded-running %d", n);
        copy_firmware(n);
        *ctrl(n) |= CTRL_EN | CTRL_RUNSTATE;
        online[n] = running[n] = 1;
        const char* u = getenv("FAKEPRUSS_UNDO");
        undo_left[n] = u ? atoi(u) : 0;
        state_file(n, "running");
    } else if (strncmp(cmd, "stop", 4) == 0 && online[n]) {
        *ctrl(n) &= ~CTRL_EN;   /* what pru_rproc_stop does; the firmware thread decides the rest */
        online[n] = 0;
        state_file(n, "offline");
        event("stop %d", n);
    }
    apply_reachability();
    pthread_mutex_unlock(&lock);
}

typedef struct {
    int n;
    char buf[64];
    size_t len;
} cookie_t;

static ssize_t cookie_write(void* c, const char* data, size_t size) {
    cookie_t* k = c;
    size_t room = sizeof(k->buf) - 1 - k->len;
    size_t take = size < room ? size : room;
    memcpy(k->buf + k->len, data, take);
    k->len += take;
    return size;
}

static int cookie_close(void* c) {
    cookie_t* k = c;
    k->buf[k->len] = 0;
    rproc_command(k->n, k->buf);
    free(k);
    return 0;
}

static FILE* state_open(const char* path, const char* how) {
    int n;
    char tail[16];
    if (!path || how[0] != 'w' ||
        sscanf(path, "/sys/class/remoteproc/remoteproc%d/%15s", &n, tail) != 2 ||
        strcmp(tail, "state") != 0 || n < 0 || n > 1) {
        return NULL;
    }
    cookie_t* k = calloc(1, sizeof(*k));
    k->n = n;
    cookie_io_functions_t io = { NULL, cookie_write, NULL, cookie_close };
    return fopencookie(k, "w", io);
}

FILE* fopen(const char* path, const char* how) {
    REAL(fopen);
    FILE* f = state_open(path, how);
    return f ? f : real_fopen(path, how);
}

FILE* fopen64(const char* path, const char* how) {
    REAL(fopen64);
    FILE* f = state_open(path, how);
    return f ? f : real_fopen64(path, how);
}
