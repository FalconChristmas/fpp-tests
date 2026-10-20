/* slowgai.so: LD_PRELOAD into fppd to make the lookup of one name stop
 * working after the first, the way a name does when the DNS server goes
 * away.  The first getaddrinfo() for $SLOWGAI_NAME answers as if for
 * $SLOWGAI_FIRST (an address), so an output configured by that name starts;
 * every later one fails with EAI_NONAME without asking the real resolver.
 * On fppd's ping threads (FPP-PingThread, FPP-PingLookup) a failing lookup
 * first appends a line to $SLOWGAI_FILE and sleeps $SLOWGAI_MS (default
 * 30000), as one does with no reachable DNS server.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int getaddrinfo(const char* node, const char* service, const struct addrinfo* hints, struct addrinfo** res) {
    static int (*real)(const char*, const char*, const struct addrinfo*, struct addrinfo**);
    static int calls;
    if (!real) {
        real = (int (*)(const char*, const char*, const struct addrinfo*, struct addrinfo**))dlsym(RTLD_NEXT, "getaddrinfo");
    }
    const char* slow = getenv("SLOWGAI_NAME");
    if (!node || !slow || strcmp(node, slow) != 0) {
        return real(node, service, hints, res);
    }
    if (__sync_fetch_and_add(&calls, 1) == 0 && getenv("SLOWGAI_FIRST")) {
        return real(getenv("SLOWGAI_FIRST"), service, hints, res);
    }
    char name[17] = { 0 };
    prctl(PR_GET_NAME, name);
    if (strncmp(name, "FPP-Ping", 8) == 0) {
        const char* file = getenv("SLOWGAI_FILE");
        FILE* f = file ? fopen(file, "a") : NULL;
        if (f) {
            fprintf(f, "%s\n", name);
            fclose(f);
        }
        const char* ms = getenv("SLOWGAI_MS");
        usleep((useconds_t)(ms ? atoi(ms) : 30000) * 1000);
    }
    return EAI_NONAME;
}
