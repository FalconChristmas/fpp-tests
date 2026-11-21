/* pinrelease.so: LD_PRELOAD into fppd to make the TmpFile pins of a
 * container build (TF-1...) let go of their line on releasePin() as a gpiod
 * line does: from then on setValue() on the pin is a silent no-op, and the
 * /tmp/GPIO-<pin> file no longer follows it, until configPin() claims the
 * line again. A TmpFile pin's own releasePin() does nothing, so without
 * this a pin released while ports still drive it goes on working.
 *
 * libfpp.so exports the pin class's methods and its vtable binds to them by
 * name, so a preloaded definition replaces the library's (as gpiothrow.cpp
 * does).
 */
#include <dlfcn.h>
#include <mutex>
#include <set>
#include <string>

static std::mutex lock;
static std::set<const void*>& released() {
    static std::set<const void*> s;
    return s;
}

class TmpFilePinCapabilities {
public:
    void releasePin() const;
    int configPin(const std::string& mode, bool directionOut, const std::string& desc) const;
    void setValue(bool i) const;
};

void TmpFilePinCapabilities::releasePin() const {
    std::lock_guard<std::mutex> l(lock);
    released().insert(this);
}

int TmpFilePinCapabilities::configPin(const std::string& mode, bool directionOut, const std::string& desc) const {
    typedef int (*fn)(const TmpFilePinCapabilities*, const std::string&, bool, const std::string&);
    static fn real = (fn)dlsym(RTLD_NEXT,
                               "_ZNK22TmpFilePinCapabilities9configPinERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEEbS7_");
    {
        std::lock_guard<std::mutex> l(lock);
        released().erase(this);
    }
    return real ? real(this, mode, directionOut, desc) : 0;
}

void TmpFilePinCapabilities::setValue(bool i) const {
    typedef void (*fn)(const TmpFilePinCapabilities*, bool);
    static fn real = (fn)dlsym(RTLD_NEXT, "_ZNK22TmpFilePinCapabilities8setValueEb");
    {
        std::lock_guard<std::mutex> l(lock);
        if (released().count(this)) {
            return;
        }
    }
    if (real) {
        real(this, i);
    }
}
