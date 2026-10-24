/*
 * fakex11.so: an X server's worth of Xlib for fppd's X11 outputs, loaded
 * with LD_PRELOAD, so X11PanelMatrix runs where there is no X server.
 *
 * XOpenDisplay() hands back a Display with one 24-bit screen, and the calls
 * that would talk to the server succeed without doing anything, except
 * XPutImage(): it writes the image to $FAKEX11_FILE (replaced in one rename,
 * so a reader never sees half a frame) as "WIDTH HEIGHT\n" and then
 * WIDTH x HEIGHT pixels of 4 bytes, B G R and one unused, as the output
 * draws them. XCreateImage() and XDestroyImage() are the client-side ones
 * Xlib has, minus what needs a server.
 */
#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int destroyImage(XImage* image) {
    free(image->data);
    free(image);
    return 1;
}

Status XInitThreads(void) {
    return 1;
}

Display* XOpenDisplay(const char* name) {
    (void)name;
    _XPrivDisplay d = calloc(1, sizeof(*d));
    Screen* s = calloc(1, sizeof(*s));
    Visual* v = calloc(1, sizeof(*v));
    v->class = TrueColor;
    v->red_mask = 0xFF0000;
    v->green_mask = 0x00FF00;
    v->blue_mask = 0x0000FF;
    v->bits_per_rgb = 8;
    s->display = (Display*)d;
    s->root = 1;
    s->width = 1920;
    s->height = 1080;
    s->root_depth = 24;
    s->root_visual = v;
    s->black_pixel = 0;
    s->white_pixel = 0xFFFFFF;
    d->screens = s;
    d->nscreens = 1;
    d->default_screen = 0;
    d->byte_order = LSBFirst;
    d->bitmap_unit = 32;
    d->bitmap_pad = 32;
    d->bitmap_bit_order = LSBFirst;
    return (Display*)d;
}

int XCloseDisplay(Display* dpy) {
    _XPrivDisplay d = (_XPrivDisplay)dpy;
    free(d->screens->root_visual);
    free(d->screens);
    free(d);
    return 0;
}

Window XDefaultRootWindow(Display* dpy) {
    return ((_XPrivDisplay)dpy)->screens->root;
}

XImage* XCreateImage(Display* dpy, Visual* visual, unsigned int depth, int format, int offset,
                     char* data, unsigned int width, unsigned int height, int bitmap_pad,
                     int bytes_per_line) {
    (void)dpy;
    (void)visual;
    XImage* img = calloc(1, sizeof(*img));
    img->width = width;
    img->height = height;
    img->xoffset = offset;
    img->format = format;
    img->data = data;
    img->byte_order = LSBFirst;
    img->bitmap_unit = 32;
    img->bitmap_bit_order = LSBFirst;
    img->bitmap_pad = bitmap_pad;
    img->depth = depth;
    img->bits_per_pixel = 32;
    img->bytes_per_line = bytes_per_line ? bytes_per_line : width * 4;
    img->red_mask = 0xFF0000;
    img->green_mask = 0x00FF00;
    img->blue_mask = 0x0000FF;
    img->f.destroy_image = destroyImage;
    return img;
}

Pixmap XCreatePixmap(Display* dpy, Drawable d, unsigned int width, unsigned int height, unsigned int depth) {
    (void)dpy, (void)d, (void)width, (void)height, (void)depth;
    return 2;
}

GC XCreateGC(Display* dpy, Drawable d, unsigned long mask, XGCValues* values) {
    (void)dpy, (void)d, (void)mask, (void)values;
    return (GC)(uintptr_t)0x1000; // never dereferenced, only freed here
}

Window XCreateWindow(Display* dpy, Window parent, int x, int y, unsigned int width, unsigned int height,
                     unsigned int border, int depth, unsigned int cls, Visual* visual,
                     unsigned long mask, XSetWindowAttributes* attrs) {
    (void)dpy, (void)parent, (void)x, (void)y, (void)width, (void)height, (void)border;
    (void)depth, (void)cls, (void)visual, (void)mask, (void)attrs;
    return 3;
}

int XPutImage(Display* dpy, Drawable d, GC gc, XImage* image, int src_x, int src_y, int dest_x,
              int dest_y, unsigned int width, unsigned int height) {
    (void)dpy, (void)d, (void)gc, (void)src_x, (void)src_y, (void)dest_x, (void)dest_y;
    const char* path = getenv("FAKEX11_FILE");
    if (!path) {
        return 0;
    }
    char tmp[4096];
    snprintf(tmp, sizeof(tmp), "%s.%d", path, getpid());
    FILE* f = fopen(tmp, "w");
    if (!f) {
        return 0;
    }
    fprintf(f, "%u %u\n", width, height);
    for (unsigned int y = 0; y < height; y++) {
        fwrite(image->data + (size_t)y * image->bytes_per_line, 4, width, f);
    }
    fclose(f);
    rename(tmp, path);
    return 0;
}

int XMapWindow(Display* dpy, Window w) { (void)dpy, (void)w; return 0; }
int XStoreName(Display* dpy, Window w, const char* name) { (void)dpy, (void)w, (void)name; return 0; }
int XSetIconName(Display* dpy, Window w, const char* name) { (void)dpy, (void)w, (void)name; return 0; }
int XFlush(Display* dpy) { (void)dpy; return 0; }
int XSync(Display* dpy, Bool discard) { (void)dpy, (void)discard; return 0; }
void XLockDisplay(Display* dpy) { (void)dpy; }
void XUnlockDisplay(Display* dpy) { (void)dpy; }
int XDestroyWindow(Display* dpy, Window w) { (void)dpy, (void)w; return 0; }
int XFreePixmap(Display* dpy, Pixmap p) { (void)dpy, (void)p; return 0; }
int XFreeGC(Display* dpy, GC gc) { (void)dpy, (void)gc; return 0; }
