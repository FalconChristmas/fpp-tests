/* noaddrs.so: LD_PRELOAD into fppd to give it a machine with no network.
 * getifaddrs() reports every non-loopback interface without an address
 * (ifa_addr NULL, as an interface that is down or unconfigured can be), so
 * the player finds nothing to announce itself on.  The list stays the
 * one the C library allocated, so freeifaddrs() is unaffected.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <ifaddrs.h>
#include <string.h>

int getifaddrs(struct ifaddrs** ifap) {
    static int (*real)(struct ifaddrs**);
    if (!real) {
        real = (int (*)(struct ifaddrs**))dlsym(RTLD_NEXT, "getifaddrs");
    }
    int rc = real(ifap);
    if (rc == 0) {
        for (struct ifaddrs* i = *ifap; i; i = i->ifa_next) {
            if (strcmp(i->ifa_name, "lo") != 0) {
                i->ifa_addr = NULL;
                i->ifa_netmask = NULL;
                i->ifa_broadaddr = NULL;
            }
        }
    }
    return rc;
}
