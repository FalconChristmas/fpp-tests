/* gpiorefuse.so: LD_PRELOAD into fppd or fppoled to make the kernel refuse
 * a gpiod line request for line $GPIOREFUSE_LINE that asks for what the
 * chip of a GPIO expander can't do, with $GPIOREFUSE_ERRNO (default EINVAL):
 *
 *   GPIOREFUSE=bias    a bias (pull-up, pull-down or disabled): an expander
 *                      with no pull resistors;
 *   GPIOREFUSE=edges   edge detection: an expander wired without its
 *                      interrupt (INT) line, which has no irq to give.
 *
 * Both may be given, comma-separated. A request without them, or for any
 * other line, goes to the kernel unchanged.
 *
 * libgpiod v2 sends a request as GPIO_V2_GET_LINE_IOCTL on the chip's fd;
 * the flags are the request's, or a per-line flags attribute's.
 * Both ioctl spellings are caught: a 32-bit build with 64-bit time_t calls
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
#include <linux/gpio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <sys/ioctl.h>

#include <string.h>

#define BIAS (GPIO_V2_LINE_FLAG_BIAS_PULL_UP | GPIO_V2_LINE_FLAG_BIAS_PULL_DOWN | \
              GPIO_V2_LINE_FLAG_BIAS_DISABLED)
#define EDGES (GPIO_V2_LINE_FLAG_EDGE_RISING | GPIO_V2_LINE_FLAG_EDGE_FALLING)

static unsigned long long refusedFlags(void) {
    const char* w = getenv("GPIOREFUSE");
    unsigned long long f = 0;
    if (w && strstr(w, "bias"))
        f |= BIAS;
    if (w && strstr(w, "edges"))
        f |= EDGES;
    return f;
}

static int refused(unsigned long req, void* arg) {
    const char* l = getenv("GPIOREFUSE_LINE");
    /* as the kernel's 32 bits: a caller passing it through an int sign-extends
     * it on a 64-bit build */
    if ((unsigned int)req != GPIO_V2_GET_LINE_IOCTL || !l || !arg) {
        return 0;
    }
    unsigned line = (unsigned)atoi(l);
    struct gpio_v2_line_request* r = arg;
    for (unsigned i = 0; i < r->num_lines && i < GPIO_V2_LINES_MAX; i++) {
        if (r->offsets[i] != line) {
            continue;
        }
        unsigned long long flags = r->config.flags;
        for (unsigned a = 0; a < r->config.num_attrs && a < GPIO_V2_LINE_NUM_ATTRS_MAX; a++) {
            struct gpio_v2_line_config_attribute* at = &r->config.attrs[a];
            if (at->attr.id == GPIO_V2_LINE_ATTR_ID_FLAGS && (at->mask & (1ULL << i))) {
                flags = at->attr.flags;
            }
        }
        if (flags & refusedFlags()) {
            const char* e = getenv("GPIOREFUSE_ERRNO");
            errno = e ? atoi(e) : EINVAL;
            return 1;
        }
    }
    return 0;
}

#define WRAP(name)                                                     \
    int name(int fd, unsigned long req, ...) {                         \
        static int (*real)(int, unsigned long, ...);                   \
        if (!real)                                                     \
            real = dlsym(RTLD_NEXT, #name);                            \
        va_list ap;                                                    \
        va_start(ap, req);                                             \
        void* arg = va_arg(ap, void*);                                 \
        va_end(ap);                                                    \
        if (refused(req, arg)) {                                       \
            return -1;                                                 \
        }                                                              \
        return real(fd, req, arg);                                     \
    }

WRAP(ioctl)
WRAP(__ioctl_time64)
