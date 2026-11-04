// A native plugin for test_plugin_abi.py: when it is destroyed it records
// whether the GPIO input GPIO_ORDER_PIN is still there to read, in the file
// GPIO_ORDER_FILE. Both are given when it is built.

#include <cstdio>
#include <json/json.h>

#include "Plugin.h"
#include "gpio.h"

class GPIOOrderPlugin : public FPPPlugins::Plugin {
public:
    GPIOOrderPlugin() :
        FPPPlugins::Plugin(PLUGIN_NAME) {}
    virtual ~GPIOOrderPlugin() {
        int value = -1;
        bool found = GPIOManager::INSTANCE.GetInputPinValue(GPIO_ORDER_PIN, value);
        if (FILE* f = fopen(GPIO_ORDER_FILE, "w")) {
            fputs(found ? "still there" : "gone", f);
            fclose(f);
        }
    }
};

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new GPIOOrderPlugin();
}
}
