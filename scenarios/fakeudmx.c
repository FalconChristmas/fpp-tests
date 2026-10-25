/* fakeudmx.so: LD_PRELOAD into fppd to give it uDMX USB dongles that are not
 * there.  It stands in for the libusb calls the UDMX output makes -- device
 * list, descriptors, bus and port numbers, open/close, the serial string
 * descriptor and the control transfer that carries the DMX values -- so the
 * output finds, opens and drives a dongle, and every call that reaches one
 * is logged.
 *
 *   FAKE_UDMX      the dongles, "BUS-PORT=SERIAL,..." (e.g. "9-7=AAA,9-8=BBB"):
 *                  each a uDMX (16c0:05dc) at that bus and port, whose serial
 *                  string descriptor is SERIAL
 *   FAKE_UDMX_LOG  where to log, one line per call:
 *                    open PATH            libusb_open()
 *                    serial PATH          the serial descriptor read (an open)
 *                    xfer PATH VALUE INDEX LENGTH HEX   a control transfer
 *                    badhandle VALUE LENGTH  one on a handle this never gave out
 *                  Transfers are logged when their data changes, and the
 *                  first 20 of each device anyway.
 *
 * Device memory is freed when its last reference goes, as in libusb, so a
 * device kept past libusb_free_device_list() without libusb_ref_device() is
 * a use after free.
 */
#define _GNU_SOURCE
#include <libusb-1.0/libusb.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAGIC 0x75444d58

struct libusb_device {
    int refs;
    int bus, port;
    char serial[64];
    char path[32];
    unsigned char last[600];
    int lastlen, xfers;
};

struct libusb_device_handle {
    int magic;
    struct libusb_device* dev;
};

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void logline(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void logline(const char* fmt, ...) {
    const char* path = getenv("FAKE_UDMX_LOG");
    if (!path) {
        return;
    }
    FILE* f = fopen(path, "a");
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

int libusb_init(libusb_context** ctx) {
    static int dummy;
    if (ctx) {
        *ctx = (libusb_context*)&dummy;
    }
    return 0;
}

void libusb_exit(libusb_context* ctx) {
    (void)ctx;
}

ssize_t libusb_get_device_list(libusb_context* ctx, libusb_device*** list) {
    (void)ctx;
    const char* spec = getenv("FAKE_UDMX");
    char buf[512];
    snprintf(buf, sizeof(buf), "%s", spec ? spec : "");
    libusb_device** out = calloc(17, sizeof(*out));
    int n = 0;
    char* save = NULL;
    for (char* tok = strtok_r(buf, ",", &save); tok && n < 16; tok = strtok_r(NULL, ",", &save)) {
        libusb_device* d = calloc(1, sizeof(*d));
        char* eq = strchr(tok, '=');
        if (eq) {
            *eq = 0;
            snprintf(d->serial, sizeof(d->serial), "%s", eq + 1);
        }
        if (sscanf(tok, "%d-%d", &d->bus, &d->port) != 2) {
            free(d);
            continue;
        }
        snprintf(d->path, sizeof(d->path), "%d-%d", d->bus, d->port);
        d->refs = 1;
        out[n++] = d;
    }
    *list = out;
    return n;
}

libusb_device* libusb_ref_device(libusb_device* dev) {
    pthread_mutex_lock(&lock);
    dev->refs++;
    pthread_mutex_unlock(&lock);
    return dev;
}

void libusb_unref_device(libusb_device* dev) {
    if (!dev) {
        return;
    }
    pthread_mutex_lock(&lock);
    int left = --dev->refs;
    pthread_mutex_unlock(&lock);
    if (left == 0) {
        free(dev);
    }
}

void libusb_free_device_list(libusb_device** list, int unref) {
    if (!list) {
        return;
    }
    if (unref) {
        for (int i = 0; list[i]; i++) {
            libusb_unref_device(list[i]);
        }
    }
    free(list);
}

int libusb_get_device_descriptor(libusb_device* dev, struct libusb_device_descriptor* desc) {
    (void)dev;
    memset(desc, 0, sizeof(*desc));
    desc->bLength = sizeof(*desc);
    desc->bDescriptorType = LIBUSB_DT_DEVICE;
    desc->idVendor = 0x16C0;
    desc->idProduct = 0x05DC;
    desc->iSerialNumber = 3;
    desc->bNumConfigurations = 1;
    return 0;
}

uint8_t libusb_get_bus_number(libusb_device* dev) {
    return (uint8_t)dev->bus;
}

uint8_t libusb_get_device_address(libusb_device* dev) {
    return (uint8_t)dev->port;
}

int libusb_get_port_numbers(libusb_device* dev, uint8_t* ports, int len) {
    if (len < 1) {
        return LIBUSB_ERROR_OVERFLOW;
    }
    ports[0] = (uint8_t)dev->port;
    return 1;
}

int libusb_open(libusb_device* dev, libusb_device_handle** handle) {
    libusb_device_handle* h = calloc(1, sizeof(*h));
    h->magic = MAGIC;
    h->dev = dev;
    *handle = h;
    logline("open %s", dev->path);
    return 0;
}

void libusb_close(libusb_device_handle* h) {
    if (h && h->magic == MAGIC) {
        h->magic = 0;
        free(h);
    }
}

int libusb_get_string_descriptor_ascii(libusb_device_handle* h, uint8_t index, unsigned char* data, int length) {
    if (!h || h->magic != MAGIC || index != 3) {
        return LIBUSB_ERROR_INVALID_PARAM;
    }
    logline("serial %s", h->dev->path);
    snprintf((char*)data, length, "%s", h->dev->serial);
    return (int)strlen((char*)data);
}

int libusb_control_transfer(libusb_device_handle* h, uint8_t type, uint8_t request, uint16_t value,
                            uint16_t index, unsigned char* data, uint16_t length, unsigned int timeout) {
    (void)type;
    (void)request;
    (void)timeout;
    if (!h || h->magic != MAGIC) {
        logline("badhandle %u %u", value, length);
        return LIBUSB_ERROR_NO_DEVICE;
    }
    libusb_device* d = h->dev;
    int n = length < sizeof(d->last) ? length : (int)sizeof(d->last);
    if (d->xfers++ < 20 || n != d->lastlen || memcmp(d->last, data, n)) {
        char hex[2 * sizeof(d->last) + 1];
        for (int i = 0; i < n; i++) {
            sprintf(hex + 2 * i, "%02x", data[i]);
        }
        hex[2 * n] = 0;
        logline("xfer %s %u %u %u %s", d->path, value, index, length, hex);
        memcpy(d->last, data, n);
        d->lastlen = n;
    }
    return length;
}

const char* libusb_error_name(int code) {
    (void)code;
    return "LIBUSB_ERROR_FAKE";
}
