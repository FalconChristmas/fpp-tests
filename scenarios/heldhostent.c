/* heldhostent.so: LD_PRELOAD into fppd to give it a host name of its own and
 * to widen the window in which gethostbyname()'s answer is shared.
 *
 * $HELDHOSTENT_NAME resolves to $HELDHOSTENT_ADDR (a dotted quad), through
 * getaddrinfo() and gethostbyname() both, without a resolver: each asks the
 * real function for the address instead.  gethostbyname() answers in a
 * hostent that is static and shared by the whole process, and it fills that
 * in for a dotted quad too; a gethostbyname() of the name holds its answer
 * for $HELDHOSTENT_MS (default 500) before handing it back, as a caller that
 * is preempted between the call and its read of h_addr is, so that a lookup
 * on another thread in the meantime rewrites what it reads.  Every other
 * name goes to the real functions untouched.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char* mapped(const char* name) {
    const char* want = getenv("HELDHOSTENT_NAME");
    const char* addr = getenv("HELDHOSTENT_ADDR");
    if (!name || !want || !addr || strcmp(name, want) != 0)
        return NULL;
    return addr;
}

struct hostent* gethostbyname(const char* name) {
    static struct hostent* (*real)(const char*);
    if (!real)
        real = (struct hostent * (*)(const char*)) dlsym(RTLD_NEXT, "gethostbyname");
    const char* addr = mapped(name);
    if (!addr)
        return real(name);
    struct hostent* h = real(addr);
    const char* ms = getenv("HELDHOSTENT_MS");
    usleep((ms ? atoi(ms) : 500) * 1000);
    return h;
}

int getaddrinfo(const char* node, const char* service, const struct addrinfo* hints, struct addrinfo** res) {
    static int (*real)(const char*, const char*, const struct addrinfo*, struct addrinfo**);
    if (!real)
        real = (int (*)(const char*, const char*, const struct addrinfo*, struct addrinfo**))dlsym(RTLD_NEXT, "getaddrinfo");
    const char* addr = mapped(node);
    return real(addr ? addr : node, service, hints, res);
}
