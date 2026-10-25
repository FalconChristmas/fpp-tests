/* gpioexpander.so: LD_PRELOAD into fppoled (or fppd) to make chosen lines of
 * a real gpiochip look like an I2C GPIO expander's (a pcf857x/pca9675), so
 * a scenario can press "expander" buttons by flipping the real pads' pulls:
 *
 *   GPIOEXP_NONAME="C:L[,C:L...]"   lines whose names the kernel reports
 *       empty, as an expander's lines are: fpp then names them
 *       <chip label>-<line> ("pinctrl-bcm2711-16"), the way a cape's
 *       cape-inputs.json "chip" + "line" finds them;
 *   GPIOEXP_ANYEDGE="C:L[,C:L...]"  lines that act like an expander line
 *       behind its irqchip, which interrupts on every change whatever edge
 *       was asked for: a request for one edge gets both from the kernel, and
 *       every event read is stamped with the edge that was asked for (what
 *       gpiolib does for such a chip), so a release reads as another press.
 *
 *   GPIOEXP_LABEL="C:label"        the chip's label as the kernel reports it:
 *       an expander's ("pcf8575") instead of the SoC's, which fpp's Pi pin
 *       table looks its chip up by and its gpiod scan skips; with
 *       GPIOEXP_LABEL_FLAG=<file>, only once that file exists -- an
 *       expander whose driver probes after fppoled has started.
 *
 *   GPIOEXP_LINES="C:n"            the chip's line count as reported with the
 *       label (same flag): a Pi 5's rp1 is otherwise still found by its 54
 *       lines when its label doesn't match. Line info for an offset past the
 *       real lines is answered here, as an unnamed input nobody holds.
 *
 * C is the gpiochip number (/dev/gpiochipC), L the line offset. The chip's
 * fds are told apart by the path they were opened with. Both ioctl
 * spellings are caught: a 32-bit build with 64-bit time_t calls
 * __ioctl_time64.
 *
 * The request is compared as 32 bits, as the kernel reads it: on a 64-bit
 * build libgpiod's request number arrives sign-extended (GPIO_V2_GET_LINEINFO
 * as 0xffffffffc100b405), so a full unsigned long compare never matches there.
 */
#undef _TIME_BITS
#undef _FILE_OFFSET_BITS
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/gpio.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define MAXFD 1024

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static int chipOf[MAXFD];    /* chip fd: chip number + 1 */
static int stampOf[MAXFD];   /* line request fd: edge id to stamp + 1 */
static unsigned realLines[256]; /* by chip: its real line count, once a raised one was reported */

static int listed(const char* env, int chip, unsigned line) {
    const char* s = getenv(env);
    while (s && *s) {
        char* end;
        long c = strtol(s, &end, 10);
        if (*end != ':') {
            return 0;
        }
        long l = strtol(end + 1, &end, 10);
        if (c == chip && l == (long)line) {
            return 1;
        }
        s = *end ? end + 1 : end;
    }
    return 0;
}

#define OPEN_WRAPPER(name)                                              \
    int name(const char* path, int flags, ...) {                        \
        static int (*real)(const char*, int, ...);                      \
        if (!real)                                                      \
            real = dlsym(RTLD_NEXT, #name);                             \
        int mode = 0;                                                   \
        if (flags & (O_CREAT | O_TMPFILE)) {                            \
            va_list ap;                                                 \
            va_start(ap, flags);                                        \
            mode = va_arg(ap, int);                                     \
            va_end(ap);                                                 \
        }                                                               \
        int fd = real(path, flags, mode);                               \
        if (fd >= 0 && fd < MAXFD) {                                    \
            int c = -1;                                                 \
            if (path && strncmp(path, "/dev/gpiochip", 13) == 0) {      \
                c = atoi(path + 13);                                    \
            }                                                           \
            pthread_mutex_lock(&lock);                                  \
            chipOf[fd] = c + 1;                                         \
            stampOf[fd] = 0;                                            \
            pthread_mutex_unlock(&lock);                                \
        }                                                               \
        return fd;                                                      \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

int close(int fd) {
    static int (*real)(int);
    if (!real)
        real = dlsym(RTLD_NEXT, "close");
    if (fd >= 0 && fd < MAXFD) {
        chipOf[fd] = 0;
        stampOf[fd] = 0;
    }
    return real(fd);
}

static int lineFlags(struct gpio_v2_line_request* r, unsigned i, unsigned long long** where) {
    *where = &r->config.flags;
    for (unsigned a = 0; a < r->config.num_attrs && a < GPIO_V2_LINE_NUM_ATTRS_MAX; a++) {
        struct gpio_v2_line_config_attribute* at = &r->config.attrs[a];
        if (at->attr.id == GPIO_V2_LINE_ATTR_ID_FLAGS && (at->mask & (1ULL << i))) {
            *where = &at->attr.flags;
        }
    }
    return 0;
}

#define EDGES (GPIO_V2_LINE_FLAG_EDGE_RISING | GPIO_V2_LINE_FLAG_EDGE_FALLING)

static int gpioIoctl(int (*real)(int, unsigned long, ...), int fd, unsigned long req, void* arg) {
    /* Compared as the 32-bit request it is: some callers pass it through an
     * int, which on a 64-bit build sign-extends GPIO_V2_GET_LINEINFO_IOCTL
     * (0xc100b405) to 0xffffffffc100b405. The kernel looks at 32 bits. */
    unsigned int nr = (unsigned int)req;
    int chip = (fd >= 0 && fd < MAXFD) ? chipOf[fd] - 1 : -1;
    if (chip < 0 || !arg) {
        return real(fd, req, arg);
    }
    if (nr == GPIO_V2_GET_LINE_IOCTL) {
        struct gpio_v2_line_request* r = arg;
        int stamp = 0;
        unsigned long long* flags = NULL;
        unsigned long long was = 0;
        if (r->num_lines == 1 && listed("GPIOEXP_ANYEDGE", chip, r->offsets[0])) {
            lineFlags(r, 0, &flags);
            was = *flags;
            if ((was & EDGES) == GPIO_V2_LINE_FLAG_EDGE_FALLING) {
                stamp = GPIO_V2_LINE_EVENT_FALLING_EDGE;
            } else if ((was & EDGES) == GPIO_V2_LINE_FLAG_EDGE_RISING) {
                stamp = GPIO_V2_LINE_EVENT_RISING_EDGE;
            }
            if (stamp) {
                *flags |= EDGES;
            }
        }
        int rc = real(fd, req, arg);
        if (flags) {
            *flags = was;
        }
        if (rc == 0 && stamp && r->fd >= 0 && r->fd < MAXFD) {
            pthread_mutex_lock(&lock);
            stampOf[r->fd] = stamp + 1;
            pthread_mutex_unlock(&lock);
        }
        return rc;
    }
    if ((nr == GPIO_V2_GET_LINEINFO_IOCTL || nr == GPIO_V2_GET_LINEINFO_WATCH_IOCTL) &&
        chip < 256 && realLines[chip] && ((struct gpio_v2_line_info*)arg)->offset >= realLines[chip]) {
        /* a line past the real ones, there only because the count was raised */
        struct gpio_v2_line_info* li = arg;
        unsigned off = li->offset;
        memset(li, 0, sizeof(*li));
        li->offset = off;
        li->flags = GPIO_V2_LINE_FLAG_INPUT;
        return 0;
    }
    int rc = real(fd, req, arg);
    const char* lab = getenv("GPIOEXP_LABEL");
    const char* flag = getenv("GPIOEXP_LABEL_FLAG");
    if (rc == 0 && nr == GPIO_GET_CHIPINFO_IOCTL && lab && atoi(lab) == chip && strchr(lab, ':') &&
        (!flag || access(flag, F_OK) == 0)) {
        struct gpiochip_info* ci = arg;
        snprintf(ci->label, sizeof(ci->label), "%s", strchr(lab, ':') + 1);
        const char* n = getenv("GPIOEXP_LINES");
        if (n && atoi(n) == chip && strchr(n, ':') && chip < 256) {
            unsigned want = (unsigned)atoi(strchr(n, ':') + 1);
            if (want > ci->lines) {
                realLines[chip] = ci->lines;
            }
            ci->lines = want;
        }
    }
    if (rc == 0 && (nr == GPIO_V2_GET_LINEINFO_IOCTL || nr == GPIO_V2_GET_LINEINFO_WATCH_IOCTL)) {
        struct gpio_v2_line_info* li = arg;
        if (listed("GPIOEXP_NONAME", chip, li->offset)) {
            li->name[0] = 0;
        }
    }
    return rc;
}

#define IOCTL_WRAPPER(name)                                            \
    int name(int fd, unsigned long req, ...) {                         \
        static int (*real)(int, unsigned long, ...);                   \
        if (!real)                                                     \
            real = dlsym(RTLD_NEXT, #name);                            \
        va_list ap;                                                    \
        va_start(ap, req);                                             \
        void* arg = va_arg(ap, void*);                                 \
        va_end(ap);                                                    \
        return gpioIoctl(real, fd, req, arg);                          \
    }
IOCTL_WRAPPER(ioctl)
IOCTL_WRAPPER(__ioctl_time64)

ssize_t read(int fd, void* buf, size_t len) {
    static ssize_t (*real)(int, void*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "read");
    ssize_t n = real(fd, buf, len);
    int stamp = (fd >= 0 && fd < MAXFD) ? stampOf[fd] - 1 : -1;
    if (stamp > 0 && n > 0) {
        struct gpio_v2_line_event* e = buf;
        for (size_t i = 0; i < (size_t)n / sizeof(*e); i++) {
            e[i].id = stamp;
        }
    }
    return n;
}
