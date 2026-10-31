// A C++ plugin, "PixelStringDump", for test_pixel_string_output.py: a pixel
// string channel output with no hardware behind it, which writes the bytes
// each port would put on the wire to a file, every frame. Built against the
// tree under test by scenarios/throw_plugin.py.
//
// Each entry in the output's "outputs" is a PixelString config, as the
// DPIPixels and BeagleBone string outputs take, plus:
//   "dumpFile"  where the port's bytes go: replaced whole each frame
//
// Out of test mode a port's bytes are PixelString::prepareOutput()'s, the
// buffer the string drivers bit-flip onto their pins; in test mode they are
// what the string tester makes of the port, handed over exactly as
// DPIPixelsOutput::PrepData() does.

#include <cstdio>
#include <string>
#include <type_traits>
#include <unistd.h>
#include <list>
#include <vector>

#include <json/json.h>

#include "Plugin.h"
#include "channeloutput/ChannelOutput.h"
#include "channeloutput/PixelString.h"
#include "channeloutput/stringtesters/PixelStringTester.h"
#include "log.h"
#include "overlays/PixelOverlay.h"

namespace {

// m_outputChannels became m_outputBytes when protocol preambles came in;
// take whichever the tree has
template <class T>
auto wireBytes(const T* p, int) -> decltype(p->m_outputBytes) { return p->m_outputBytes; }
template <class T>
auto wireBytes(const T* p, long) -> decltype(p->m_outputChannels) { return p->m_outputChannels; }

struct DumpPort {
    PixelString* ps = nullptr;
    std::string file;
};

class PixelStringDumpOutput : public ChannelOutput {
public:
    PixelStringDumpOutput(unsigned int startChannel, unsigned int channelCount) :
        ChannelOutput(startChannel, channelCount) {}
    virtual ~PixelStringDumpOutput() { closePorts(); }

    virtual std::string GetOutputType() const override { return "PixelStringDump"; }

    virtual int Init(Json::Value config) override {
        for (unsigned int i = 0; i < config["outputs"].size(); i++) {
            Json::Value s = config["outputs"][i];
            DumpPort p;
            p.file = s["dumpFile"].asString();
            p.ps = new PixelString(true);
            ports.push_back(p);
            if (!p.ps->Init(s)) {
                return 0;
            }
        }
        // as the string drivers do, so the overlay models they auto-create
        // can be checked
        std::vector<PixelString*> all;
        for (auto& p : ports) {
            all.push_back(p.ps);
        }
        PixelString::AutoCreateOverlayModels(all, autoModels);
        return ChannelOutput::Init(config);
    }
    virtual int Close() override {
        for (auto& n : autoModels) {
            PixelOverlayManager::INSTANCE.removeAutoOverlayModel(n);
        }
        autoModels.clear();
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
            uint32_t len = wireBytes(p.ps, 0);
            uint8_t* out = tester ? tester->createTestData(p.ps, testCycle, testPercent, channelData, len)
                                  : p.ps->prepareOutput(channelData);
            dump(p.file, out, len);
        }
        testCycle = -1;
    }
    virtual int SendData(unsigned char* channelData) override { return m_channelCount; }
    virtual void GetRequiredChannelRanges(const std::function<void(int, int)>& addRange) override {
        for (auto& p : ports) {
            for (auto& vs : p.ps->m_virtualStrings) {
                if (vs.pixelCount) {
                    addRange(vs.startChannel, vs.startChannel + vs.pixelCount * vs.channelsPerNode() - 1);
                }
            }
        }
    }

private:
    static void dump(const std::string& file, const uint8_t* data, uint32_t len) {
        // written aside and renamed over, so a reader never sees half a frame
        std::string tmp = file + ".tmp";
        FILE* f = fopen(tmp.c_str(), "wb");
        if (!f) {
            LogErr(VB_CHANNELOUT, "PixelStringDump: could not write %s\n", tmp.c_str());
            return;
        }
        if (len) {
            fwrite(data, 1, len, f);
        }
        fclose(f);
        rename(tmp.c_str(), file.c_str());
    }
    void closePorts() {
        for (auto& p : ports) {
            delete p.ps;
        }
        ports.clear();
    }

    std::vector<DumpPort> ports;
    std::list<std::string> autoModels;
    int testCycle = -1;
    int testType_ = 0;
    float testPercent = 0;
};

class PixelStringDumpPlugin : public FPPPlugins::Plugin, public FPPPlugins::ChannelOutputPlugin {
public:
    PixelStringDumpPlugin() :
        FPPPlugins::Plugin("PixelStringDump") {}
    virtual ChannelOutput* createChannelOutput(unsigned int startChannel, unsigned int channelCount) override {
        return new PixelStringDumpOutput(startChannel, channelCount);
    }
};

} // namespace

extern "C" {
FPPPlugins::Plugin* createPlugin() {
    return new PixelStringDumpPlugin();
}
}
