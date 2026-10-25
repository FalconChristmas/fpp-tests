/* netguard_mac.dylib: DYLD_INSERT_LIBRARIES into a test fppd on macOS, which
 * has no network namespace to put it in, so that it reaches nothing past
 * the loopback interface.  Every connect(), sendto() and sendmsg() to an
 * address that is not 127.0.0.0/8 or ::1 fails with ENETUNREACH (MultiSync's
 * broadcast and unicast pings, pings, outputs, HTTP probes); Bonjour
 * registration, browsing and resolving fail (no mDNS advertisement on the
 * LAN); and getaddrinfo() of any name but localhost fails.  Each refusal is
 * logged to $NETGUARD_LOG, one line per call, for the scenario to read.
 */
#include <arpa/inet.h>
#include <dns_sd.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>

#define INTERPOSE(replacement, replacee)                                                   \
    __attribute__((used)) static struct {                                                  \
        const void* r;                                                                     \
        const void* e;                                                                     \
    } interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {              \
        (const void*)(unsigned long)&replacement, (const void*)(unsigned long)&replacee }

static void note(const char* what, const char* detail) {
    const char* path = getenv("NETGUARD_LOG");
    if (!path) {
        return;
    }
    FILE* f = fopen(path, "a");
    if (f) {
        fprintf(f, "%s %s\n", what, detail ? detail : "");
        fclose(f);
    }
}

static int local(const struct sockaddr* a, char* text, size_t len) {
    text[0] = 0;
    if (!a) {
        return 1;
    }
    if (a->sa_family == AF_INET) {
        const struct sockaddr_in* in = (const struct sockaddr_in*)a;
        inet_ntop(AF_INET, &in->sin_addr, text, len);
        return (ntohl(in->sin_addr.s_addr) >> 24) == 127;
    }
    if (a->sa_family == AF_INET6) {
        const struct sockaddr_in6* in6 = (const struct sockaddr_in6*)a;
        inet_ntop(AF_INET6, &in6->sin6_addr, text, len);
        if (IN6_IS_ADDR_LOOPBACK(&in6->sin6_addr)) {
            return 1;
        }
        if (IN6_IS_ADDR_V4MAPPED(&in6->sin6_addr)) {
            return in6->sin6_addr.s6_addr[12] == 127;
        }
        return 0;
    }
    return 1; /* AF_UNIX and the like stay on this machine */
}

static int g_connect(int fd, const struct sockaddr* a, socklen_t l) {
    char t[64];
    if (!local(a, t, sizeof(t))) {
        note("connect", t);
        errno = ENETUNREACH;
        return -1;
    }
    return connect(fd, a, l);
}
INTERPOSE(g_connect, connect);

static ssize_t g_sendto(int fd, const void* b, size_t n, int fl, const struct sockaddr* a, socklen_t l) {
    char t[64];
    if (a && !local(a, t, sizeof(t))) {
        note("sendto", t);
        errno = ENETUNREACH;
        return -1;
    }
    return sendto(fd, b, n, fl, a, l);
}
INTERPOSE(g_sendto, sendto);

static ssize_t g_sendmsg(int fd, const struct msghdr* m, int fl) {
    char t[64];
    if (m && m->msg_name && !local((const struct sockaddr*)m->msg_name, t, sizeof(t))) {
        note("sendmsg", t);
        errno = ENETUNREACH;
        return -1;
    }
    return sendmsg(fd, m, fl);
}
INTERPOSE(g_sendmsg, sendmsg);

static int g_getaddrinfo(const char* host, const char* serv, const struct addrinfo* hints, struct addrinfo** res) {
    if (host && strcmp(host, "localhost") && strncmp(host, "127.", 4) && strcmp(host, "::1")) {
        note("getaddrinfo", host);
        return EAI_NONAME;
    }
    return getaddrinfo(host, serv, hints, res);
}
INTERPOSE(g_getaddrinfo, getaddrinfo);

static DNSServiceErrorType g_register(DNSServiceRef* r, DNSServiceFlags f, uint32_t i, const char* name,
                                      const char* type, const char* dom, const char* host, uint16_t port,
                                      uint16_t tl, const void* txt, DNSServiceRegisterReply cb, void* ctx) {
    note("bonjour-register", type);
    return kDNSServiceErr_Unknown;
}
INTERPOSE(g_register, DNSServiceRegister);

static DNSServiceErrorType g_browse(DNSServiceRef* r, DNSServiceFlags f, uint32_t i, const char* type,
                                    const char* dom, DNSServiceBrowseReply cb, void* ctx) {
    note("bonjour-browse", type);
    return kDNSServiceErr_Unknown;
}
INTERPOSE(g_browse, DNSServiceBrowse);

static DNSServiceErrorType g_resolve(DNSServiceRef* r, DNSServiceFlags f, uint32_t i, const char* name,
                                     const char* type, const char* dom, DNSServiceResolveReply cb, void* ctx) {
    note("bonjour-resolve", name);
    return kDNSServiceErr_Unknown;
}
INTERPOSE(g_resolve, DNSServiceResolve);
