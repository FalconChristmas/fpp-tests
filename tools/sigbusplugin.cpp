// A C++ plugin, "fpp-sigbus", for test_sigbus_thread.py: its route raises SIGBUS
// on a thread of its own, as a video consumer thread touching a dead DRM buffer
// would. Built against the tree under test by throw_plugin.py.
//
//   /sigbus/thread   starts the thread, joins it and answers 200 "survived"
//   /sigbus/refault?marker=<path>
//                    a real (hardware) SIGBUS: the thread reads a mapping of a
//                    file truncated under it, and a thread-specific data
//                    destructor, run as the crash handler ends the thread,
//                    creates <path> and reads the mapping again -- a fault on
//                    a thread already on its way out

#include <csignal>
#include <fcntl.h>
#include <pthread.h>
#include <string>
#include <sys/mman.h>
#include <unistd.h>

#include "Plugin.h"
#include "fpphttp.h"

namespace {

void* raiser(void*) {
    pthread_kill(pthread_self(), SIGBUS);
    return nullptr;
}

std::string refaultMarker;

__attribute__((noinline)) void readPage(void* mapping) {
    (void)*static_cast<volatile char*>(mapping);
    asm volatile("" ::: "memory");
}

// The second fault comes from a thread-specific data destructor: those run as
// any thread exits, pthread_exit() from the crash handler included. (A
// pthread_cleanup_push() handler doesn't: that unwind doesn't get past the
// signal frame, so the thread ends without running it.)
void touchAgain(void* mapping) {
    int fd = open(refaultMarker.c_str(), O_CREAT | O_WRONLY, 0644);
    if (fd >= 0) {
        close(fd);
    }
    readPage(mapping);
}

pthread_key_t refaultKey;
pthread_once_t refaultKeyOnce = PTHREAD_ONCE_INIT;
void makeRefaultKey() {
    pthread_key_create(&refaultKey, touchAgain);
}

void* refaulter(void*) {
    char path[] = "/tmp/fpp-sigbus-XXXXXX";
    int fd = mkstemp(path);
    if (fd < 0 || ftruncate(fd, 4096) != 0) {
        return nullptr;
    }
    void* m = mmap(nullptr, 4096, PROT_READ, MAP_SHARED, fd, 0);
    // Past the end of the file now: reading the page is a SIGBUS.
    if (m == MAP_FAILED || ftruncate(fd, 0) != 0) {
        return nullptr;
    }
    close(fd);
    unlink(path);
    pthread_once(&refaultKeyOnce, makeRefaultKey);
    pthread_setspecific(refaultKey, m);
    readPage(m);
    return nullptr;
}

class SigbusPlugin : public FPPPlugin {
public:
    SigbusPlugin() :
        FPPPlugin("fpp-sigbus") {}

    void registerApis() override {
        FPPPlugins::registerPluginApi("/sigbus/thread", [](const HttpRequestPtr&, HttpCallback&& cb) {
            pthread_t t;
            pthread_create(&t, nullptr, raiser, nullptr);
            pthread_join(t, nullptr);
            cb(makeStringResponse("survived", 200, "text/plain"));
        });
        FPPPlugins::registerPluginApi("/sigbus/refault", [](const HttpRequestPtr& req, HttpCallback&& cb) {
            refaultMarker = req->getParameter("marker");
            pthread_t t;
            pthread_create(&t, nullptr, refaulter, nullptr);
            pthread_join(t, nullptr);
            cb(makeStringResponse("survived", 200, "text/plain"));
        });
    }
    void unregisterApis() override {
        FPPPlugins::unregisterPluginApi("/sigbus/thread");
        FPPPlugins::unregisterPluginApi("/sigbus/refault");
    }
};

} // namespace

extern "C" FPPPlugins::Plugin* createPlugin() {
    return new SigbusPlugin();
}
