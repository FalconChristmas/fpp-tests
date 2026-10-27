/* hangatexit.so: LD_PRELOAD into fppd to give it a library destructor that
 * never returns, as ~RTSPOutputManager does when the crashed thread still
 * holds its apply lock.  exit() runs it and hangs; _exit() skips it.  Only
 * fppd itself hangs: not its forked children, nor the programs it runs
 * (which inherit LD_PRELOAD), so its scripts and helpers still finish.  The
 * destructor writes $HANGATEXIT_FILE first, so a test can tell it ran.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static pid_t owner;

__attribute__((constructor)) static void init(void) {
    if (strcmp(program_invocation_short_name, "fppd") == 0) {
        owner = getpid();
    }
}

__attribute__((destructor)) static void hang(void) {
    if (!owner || getpid() != owner) {
        return;
    }
    const char* file = getenv("HANGATEXIT_FILE");
    FILE* f = file ? fopen(file, "w") : NULL;
    if (f) {
        fputs("destructor ran\n", f);
        fclose(f);
    }
    for (;;) {
        pause();
    }
}
