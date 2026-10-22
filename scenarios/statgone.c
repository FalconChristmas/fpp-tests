/* statgone.so: LD_PRELOAD into fppd to delete a file right after fppd has
 * checked that it exists, as a user removing it at that moment would.
 *
 * While the file $STATGONE_ARM exists, the first stat() of a path ending in
 * $STATGONE_SUFFIX that finds the file removes $STATGONE_ARM and then the
 * file itself, and returns the successful result: the caller saw the file,
 * and its next look finds it gone.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void maybe_remove(const char* path, int rc) {
    const char* suffix = getenv("STATGONE_SUFFIX");
    const char* arm = getenv("STATGONE_ARM");
    if (rc != 0 || !suffix || !arm || !path)
        return;
    size_t n = strlen(path), m = strlen(suffix);
    if (n < m || strcmp(path + n - m, suffix) != 0)
        return;
    if (unlink(arm) == 0)
        unlink(path);
}

int stat(const char* path, struct stat* st) {
    static int (*real)(const char*, struct stat*);
    if (!real)
        real = (int (*)(const char*, struct stat*))dlsym(RTLD_NEXT, "stat");
    int rc = real(path, st);
    maybe_remove(path, rc);
    return rc;
}

int stat64(const char* path, struct stat64* st) {
    static int (*real)(const char*, struct stat64*);
    if (!real)
        real = (int (*)(const char*, struct stat64*))dlsym(RTLD_NEXT, "stat64");
    int rc = real(path, st);
    maybe_remove(path, rc);
    return rc;
}
