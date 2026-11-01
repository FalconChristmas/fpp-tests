/* fakereadlink.so: LD_PRELOAD into PHP's CLI to say which driver a sound
 * card is bound to where there is no /sys/class/sound (the web container).
 * readlink("/sys/class/sound/card<N>/device/driver") answers
 * ../../../../bus/usb/drivers/snd-usb-audio for each N in $FAKE_USB_CARDS
 * (a comma list) and ../../../../bus/platform/drivers/bcm2835_audio for any
 * other card; every other path goes through. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

ssize_t readlink(const char* path, char* buf, size_t size) {
    static ssize_t (*real)(const char*, char*, size_t);
    if (!real)
        real = dlsym(RTLD_NEXT, "readlink");
    int n;
    const char* suffix = "/device/driver";
    size_t plen = path ? strlen(path) : 0;
    if (path && strncmp(path, "/sys/class/sound/card", 21) == 0 && plen > strlen(suffix) &&
        strcmp(path + plen - strlen(suffix), suffix) == 0) {
        n = atoi(path + 21);
        const char* usb = getenv("FAKE_USB_CARDS");
        int isUsb = 0;
        for (const char* p = usb; p && *p;) {
            if (atoi(p) == n && (p == usb || p[-1] == ',') )
                isUsb = 1;
            p = strchr(p, ',');
            if (p)
                p++;
        }
        const char* target = isUsb ? "../../../../bus/usb/drivers/snd-usb-audio" : "../../../../bus/platform/drivers/bcm2835_audio";
        size_t len = strlen(target);
        if (len > size)
            len = size;
        memcpy(buf, target, len);
        return (ssize_t)len;
    }
    return real(path, buf, size);
}
