/* med_noreboot.so: LD_PRELOAD into fppd so it can't reboot the machine.
 * system() of a command naming "reboot" appends the command to
 * $NOREBOOT_LOG and returns $NOREBOOT_RC (default 0, "the reboot is under
 * way") without running it; every other command runs as usual.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int system(const char* cmd) {
    static int (*real)(const char*);
    if (!real) {
        real = (int (*)(const char*))dlsym(RTLD_NEXT, "system");
    }
    if (cmd && strstr(cmd, "reboot")) {
        const char* log = getenv("NOREBOOT_LOG");
        if (log) {
            FILE* f = fopen(log, "a");
            if (f) {
                fprintf(f, "%s\n", cmd);
                fclose(f);
            }
        }
        const char* rc = getenv("NOREBOOT_RC");
        return rc ? atoi(rc) : 0;
    }
    return real(cmd);
}
