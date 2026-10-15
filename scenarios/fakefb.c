/*
 * A fake Linux framebuffer for fppd's IOCTLFrameBuffer, loaded with
 * LD_PRELOAD (see framebuffer.py).
 *
 * fppd opens "<framebufferControlSocketPath>/<device>", so pointing that
 * setting at a directory of ordinary files gets them opened and mmap()ed as
 * if they were /dev/fbN: the pixels land in the file, where a test reads
 * them. What a file can't do is answer the fbdev ioctls, so this answers
 * them for any fd open on a file under FAKEFB_DIR and passes every other
 * ioctl through.
 *
 *   FAKEFB_DIR    the directory of fake devices
 *   FAKEFB_GEOM   "WIDTHxHEIGHTxBPP" of the visible mode, as the driver
 *                 reports it (BPP 16, 24 or 32)
 *   FAKEFB_FIXED  "1": behave like fbtft, whose driver has no fb_check_var:
 *                 FBIOPUT_VSCREENINFO succeeds and changes nothing, and the
 *                 video memory is the file's size whatever was asked for
 *
 * The file's size is the video memory (smem_len). A request for more
 * virtual height than it holds fails, as a driver short of memory does.
 * The mode, after every change to it, is written to "<file>.var" as
 * "xres yres xres_virtual yres_virtual bits_per_pixel yoffset", so a test
 * can tell how the pixels are laid out and which page is on screen.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct fb_var_screeninfo var;
static int haveVar;

static int (*realIoctl)(int, unsigned long, ...);

static void setColor(struct fb_var_screeninfo* v) {
    memset(&v->red, 0, sizeof(v->red) * 4);
    if (v->bits_per_pixel == 16) {
        v->red.offset = 11, v->red.length = 5;
        v->green.offset = 5, v->green.length = 6;
        v->blue.offset = 0, v->blue.length = 5;
    } else {
        v->red.offset = 16, v->red.length = 8;
        v->green.offset = 8, v->green.length = 8;
        v->blue.offset = 0, v->blue.length = 8;
        if (v->bits_per_pixel == 32) {
            v->transp.offset = 24, v->transp.length = 8;
        }
    }
}

static void initVar(void) {
    if (haveVar) {
        return;
    }
    unsigned w = 64, h = 32, bpp = 24;
    const char* g = getenv("FAKEFB_GEOM");
    if (g) {
        sscanf(g, "%ux%ux%u", &w, &h, &bpp);
    }
    memset(&var, 0, sizeof(var));
    var.xres = var.xres_virtual = w;
    var.yres = var.yres_virtual = h;
    var.bits_per_pixel = bpp;
    setColor(&var);
    haveVar = 1;
}

/* The path behind fd if it is one of ours, else an empty string. */
static int fakePath(int fd, char* path, size_t len) {
    const char* dir = getenv("FAKEFB_DIR");
    if (!dir || !*dir) {
        return 0;
    }
    char link[64];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(link, path, len - 1);
    if (n <= 0) {
        return 0;
    }
    path[n] = 0;
    size_t dl = strlen(dir);
    return strncmp(path, dir, dl) == 0 && path[dl] == '/';
}

static unsigned lineLength(const struct fb_var_screeninfo* v) {
    return v->xres_virtual * ((v->bits_per_pixel + 7) / 8);
}

static void saveVar(const char* path) {
    char name[4200];
    snprintf(name, sizeof(name), "%s.var", path);
    char tmp[4300];
    snprintf(tmp, sizeof(tmp), "%s.tmp", name);
    FILE* f = fopen(tmp, "w");
    if (f) {
        fprintf(f, "%u %u %u %u %u %u\n", var.xres, var.yres, var.xres_virtual, var.yres_virtual,
                var.bits_per_pixel, var.yoffset);
        fclose(f);
        rename(tmp, name);
    }
}

static int fakeIoctl(int fd, const char* path, unsigned long req, void* arg) {
    struct stat st;
    if (fstat(fd, &st)) {
        return -1;
    }
    int fixed = getenv("FAKEFB_FIXED") && strcmp(getenv("FAKEFB_FIXED"), "1") == 0;
    pthread_mutex_lock(&lock);
    initVar();
    int rc = 0;
    switch (req) {
    case FBIOGET_VSCREENINFO:
        memcpy(arg, &var, sizeof(var));
        saveVar(path);
        break;
    case FBIOPUT_VSCREENINFO: {
        if (fixed) {
            break;
        }
        struct fb_var_screeninfo want;
        memcpy(&want, arg, sizeof(want));
        if (want.bits_per_pixel != 16 && want.bits_per_pixel != 24 && want.bits_per_pixel != 32) {
            errno = EINVAL;
            rc = -1;
            break;
        }
        if (want.xres_virtual < want.xres) {
            want.xres_virtual = want.xres;
        }
        if (want.yres_virtual < want.yres) {
            want.yres_virtual = want.yres;
        }
        if ((unsigned long long)lineLength(&want) * want.yres_virtual > (unsigned long long)st.st_size) {
            errno = ENOMEM;
            rc = -1;
            break;
        }
        setColor(&want);
        var = want;
        memcpy(arg, &var, sizeof(var));
        saveVar(path);
        break;
    }
    case FBIOGET_FSCREENINFO: {
        struct fb_fix_screeninfo fix;
        memset(&fix, 0, sizeof(fix));
        strncpy(fix.id, "fakefb", sizeof(fix.id) - 1);
        fix.smem_len = st.st_size;
        fix.type = FB_TYPE_PACKED_PIXELS;
        fix.visual = FB_VISUAL_TRUECOLOR;
        fix.line_length = lineLength(&var);
        fix.ypanstep = 1;
        memcpy(arg, &fix, sizeof(fix));
        break;
    }
    case FBIOPAN_DISPLAY: {
        const struct fb_var_screeninfo* v = arg;
        if (v->yoffset + var.yres > var.yres_virtual) {
            errno = EINVAL;
            rc = -1;
            break;
        }
        var.yoffset = v->yoffset;
        saveVar(path);
        break;
    }
    case FBIO_WAITFORVSYNC:
        pthread_mutex_unlock(&lock);
        usleep(16000);
        return 0;
    default:
        errno = ENOTTY;
        rc = -1;
    }
    pthread_mutex_unlock(&lock);
    return rc;
}

int ioctl(int fd, unsigned long req, ...) {
    va_list ap;
    va_start(ap, req);
    void* arg = va_arg(ap, void*);
    va_end(ap);
    char path[4096];
    if (fakePath(fd, path, sizeof(path))) {
        return fakeIoctl(fd, path, req, arg);
    }
    if (!realIoctl) {
        realIoctl = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
    }
    return realIoctl(fd, req, arg);
}
