/* gpiothrow.so: LD_PRELOAD into fppd to make a GPIO pin's setValue() throw,
 * as a pin whose driver went away would, while $GPIOTHROW_FLAG exists; once
 * the file is gone the real setValue() runs again.
 *
 * It interposes the setValue() of the pin classes the outputs drive: the
 * TmpFile pins of a container build (TF-1...) and the gpiod lines of a Pi
 * or BeagleBone. libfpp.so exports them and its vtables bind to them by
 * name, so a preloaded definition replaces the library's.
 */
#include <dlfcn.h>
#include <stdexcept>
#include <stdlib.h>
#include <unistd.h>

static bool failing() {
    const char* f = getenv("GPIOTHROW_FLAG");
    return f && access(f, F_OK) == 0;
}

#define INTERPOSE(cls, sym)                                                        \
    class cls {                                                                    \
    public:                                                                        \
        void setValue(bool i) const;                                               \
    };                                                                             \
    void cls::setValue(bool i) const {                                             \
        typedef void (*fn)(const cls*, bool);                                      \
        static fn real = (fn)dlsym(RTLD_NEXT, sym);                                \
        if (failing()) {                                                           \
            throw std::runtime_error("gpiothrow: the pin is gone");                \
        }                                                                          \
        if (real) {                                                                \
            real(this, i);                                                         \
        }                                                                          \
    }

INTERPOSE(TmpFilePinCapabilities, "_ZNK22TmpFilePinCapabilities8setValueEb")
INTERPOSE(GPIODCapabilities, "_ZNK17GPIODCapabilities8setValueEb")
