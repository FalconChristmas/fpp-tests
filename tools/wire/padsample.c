// Records every level change of one AM62x GPIO pad, timestamped with the ARM
// generic timer, plus every sampling gap long enough to hide an edge.
// usage: padsample <seconds> <bank-phys-base> <IN_DATA offset> <bit> <gap-ns>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>
static inline uint64_t cnt(void) { uint64_t v; asm volatile("isb; mrs %0, cntvct_el0" : "=r"(v)); return v; }
static inline uint64_t frq(void) { uint64_t v; asm volatile("mrs %0, cntfrq_el0" : "=r"(v)); return v; }
int main(int argc, char** argv) {
    double secs = atof(argv[1]);
    off_t base = strtoul(argv[2], 0, 0);
    unsigned off = strtoul(argv[3], 0, 0), bit = atoi(argv[4]);
    double gapns = atof(argv[5]);
    int fd = open("/dev/mem", O_RDONLY | O_SYNC);
    volatile uint32_t* g = mmap(0, 4096, PROT_READ, MAP_SHARED, fd, base);
    if (g == MAP_FAILED) { perror("mmap"); return 1; }
    uint64_t f = frq(), gap = (uint64_t)(gapns * f / 1e9), end = cnt() + (uint64_t)(secs * f);
    size_t cap = 4000000, n = 0;
    uint64_t* t = malloc(cap * 8); uint8_t* k = malloc(cap);   // k: 0/1 level, 2 gap start, 3 gap end
    unsigned last = (g[off / 4] >> bit) & 1; uint64_t tp = cnt(), samples = 0;
    t[n] = tp; k[n++] = last;
    while (n < cap - 4) {
        unsigned v = (g[off / 4] >> bit) & 1;
        uint64_t now = cnt(); samples++;
        if (now - tp > gap) { t[n] = tp; k[n++] = 2; t[n] = now; k[n++] = 3; }
        if (v != last) { t[n] = now; k[n++] = v; last = v; }
        tp = now;
        if (now > end) break;
    }
    printf("F %llu %llu\n", (unsigned long long)f, (unsigned long long)samples);
    for (size_t i = 0; i < n; i++) printf("%c %llu\n", "LHgG"[k[i]], (unsigned long long)t[i]);
    return 0;
}
