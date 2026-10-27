/* drogonversion.so: LD_PRELOAD into fppd to make libdrogon report the
 * version in $DROGON_FAKE_VERSION from drogon::getVersion(), as a library
 * from a different drogon release than fppd's headers would.  fppd calls it
 * through the PLT, so the preloaded definition is the one it gets.
 */
#include <cstdlib>
#include <string>

namespace drogon {
std::string getVersion() {
    const char* v = getenv("DROGON_FAKE_VERSION");
    return v ? v : "";
}
} // namespace drogon
