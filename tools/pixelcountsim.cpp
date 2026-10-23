// A C++ plugin, "PixelCountSim", for test_pixel_count.py: a pixel string
// channel output whose ports have a current sensor, with a simulated string
// of pixels on each, so the current-based pixel count (test type 999) runs
// with no hardware. Built against the tree under test by
// scenarios/throw_plugin.py.
//
// Each entry in the output's "outputs" is a PixelString config, as the
// DPIPixels and BeagleBone string outputs take, plus:
//   "simCurrentFile"  the file the port's current sensor reads, in mA
//                     (the port config fppd gets carries it as
//                     currentSensor.path, as a cape's does)
//   "simWirePixels"   how many pixels are physically on the wire
//
// Every frame, in test mode, the output hands the strings to the string
// tester exactly as DPIPixelsOutput::PrepData() does, then writes each
// port's current: 30 mA dark, plus 60 mA for each pixel on the wire at full
// white (in proportion for less), for the bytes the tester sends. Bytes past
// the frame the tester cuts are never sent, and pixels past the wire draw
// nothing. Out of test mode it sends nothing and reads dark.

#include <algorithm>
#include <cstdio>
#include <fcntl.h>
#include <string>
#include <unistd.h>
#include <vector>

#include <json/json.h>

#include "Plugin.h"
#include "channeloutput/ChannelOutput.h"
#include "channeloutput/PixelString.h"
#include "channeloutput/stringtesters/PixelStringTester.h"
#include "log.h"

namespace {

constexpr int DARK_MA = 30;
constexpr int PIXEL_MA = 60;

struct SimPort {
    PixelString* ps = nullptr;
    int fd = -1;
    int wirePixels = 0;
};

class PixelCountSimOutput : public ChannelOutput {
public:
    PixelCountSimOutput(unsigned int startChannel, unsigned int channelCount) :
        ChannelOutput(startChannel, channelCount) {}
    virtual ~PixelCountSimOutput() { closePorts(); }

    virtual std::string GetOutputType() const override { return "PixelCountSim"; }

    virtual int Init(Json::Value config) override {
        for (unsigned int i = 0; i < config["outputs"].size(); i++) {
            Json::Value s = config["outputs"][i];
            SimPort p;
            std::string path = s["simCurrentFile"].asString();
            // the sensor opens its file when the port is configured
            p.fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
            p.wirePixels = s["simWirePixels"].asInt();
            ports.push_back(p);
            writeCurrent(ports.back(), DARK_MA);
            Json::Value pin;
            pin["currentSensor"]["path"] = path;
            pin["currentSensor"]["scale"] = 1.0;
            ports.back().ps = new PixelString(true);
            if (!ports.back().ps->Init(s, &pin)) {
                return 0;
            }
        }
        return ChannelOutput::Init(config);
    }
    virtual int Close() override {
        closePorts();
        return ChannelOutput::Close();
    }
    virtual bool SupportsTesting() const override { return true; }
    virtual void OverlayTestData(unsigned char* channelData, int cycleNum, float percentOfCycle, int testType, const Json::Value& config) override {
        testCycle = cycleNum;
        testType_ = testType;
        testPercent = percentOfCycle;
    }
    virtual void PrepData(unsigned char* channelData) override {
        PixelStringTester* tester = nullptr;
        if (testType_ && testCycle >= 0) {
            tester = PixelStringTester::getPixelStringTester(testType_);
            if (tester) {
                tester->prepareTestData(testCycle, testPercent);
            }
        }
        for (auto& p : ports) {
            int ma = DARK_MA;
            if (tester) {
                uint32_t len = 0;
                uint8_t* out = tester->createTestData(p.ps, testCycle, testPercent, channelData, len);
                // ws2811, 3 bytes a pixel, no preamble
                uint32_t bytes = std::min<uint32_t>(len, (uint32_t)p.wirePixels * 3);
                long sum = 0;
                for (uint32_t b = 0; b < bytes; b++) {
                    sum += out[b];
                }
                ma += (int)(sum * PIXEL_MA / (3 * 255));
            }
            writeCurrent(p, ma);
        }
    }
    virtual int SendData(unsigned char* channelData) override { return m_channelCount; }
    virtual void GetRequiredChannelRanges(const std::function<void(int, int)>& addRange) override {}

private:
    static void writeCurrent(SimPort& p, int ma) {
        if (p.fd < 0) {
            return;
        }
        // fixed width, rewritten in place: a sensor read never sees a
        // shortened or empty file
        char buf[12];
        snprintf(buf, sizeof(buf), "%10d\n", ma);
        if (pwrite(p.fd, buf, 11, 0) != 11) {
            LogErr(VB_CHANNELOUT, "PixelCountSim: could not write the port's current\n");
        }
    }
    void closePorts() {
        for (auto& p : ports) {
            delete p.ps;
            if (p.fd >= 0) {
                close(p.fd);
            }
        }
        ports.clear();
    }

    std::vector<SimPort> ports;
    int testCycle = -1;
    int testType_ = 0;
    float testPercent = 0;
};

class PixelCountSimPlugin : public FPPPlugins::Plugin, public FPPPlugins::ChannelOutputPlugin {
public:
    PixelCountSimPlugin() :
        FPPPlugins::Plugin("PixelCountSim") {}
    virtual ChannelOutput* createChannelOutput(unsigned int startChannel, unsigned int channelCount) override {
        return new PixelCountSimOutput(startChannel, channelCount);
    }
};

} // namespace

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new PixelCountSimPlugin();
}
}
