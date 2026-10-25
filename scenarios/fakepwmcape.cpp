/* fakepwmcape.so: LD_PRELOAD into fppd to give it a cape's PWM config
 * (media/tmp/pwm/<subType>.json on a cape) for co-pwm.json outputs, with no
 * cape: CapeUtils::getPWMConfig() reads <subType>.json from
 * $FAKEPWMCAPE_DIR instead. On a real cape the file comes out of its signed
 * EEPROM, which a scenario can't make, so the PCA9685's co-pwm.json path
 * (the Servos/PWM tab) is otherwise out of reach. Everything else about the
 * output -- its ports, data types and the bus writes -- is fppd's own.
 */
#include <dlfcn.h>
#include <fstream>
#include <json/json.h>
#include <stdlib.h>
#include <string>

class CapeUtils {
public:
    bool getPWMConfig(const std::string& type, Json::Value& val);
};

bool CapeUtils::getPWMConfig(const std::string& type, Json::Value& val) {
    const char* dir = getenv("FAKEPWMCAPE_DIR");
    if (!dir) {
        typedef bool (*fn)(CapeUtils*, const std::string&, Json::Value&);
        static fn real = (fn)dlsym(RTLD_NEXT, "_ZN9CapeUtils12getPWMConfigERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEERN4Json5ValueE");
        return real && real(this, type, val);
    }
    std::ifstream f(std::string(dir) + "/" + type + ".json");
    if (!f) {
        return false;
    }
    Json::CharReaderBuilder b;
    std::string errors;
    return Json::parseFromStream(b, f, &val, &errors);
}
