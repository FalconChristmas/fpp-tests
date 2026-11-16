// AM335x discovery fixture: no legacy GPIO sysfs, generic chip labels, and unnamed lines.
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <dirent.h>
#include <limits.h>
#include <map>
#include <string>
#include <sys/stat.h>
#include <vector>

static std::string root;
static int chipCount;
static uint32_t bbGPIOMap[] = { 0, 0, 0, 0 };
static bool registersMemMapped = false;

static bool FileExists(const std::string& path) {
    int chip;
    return sscanf(path.c_str(), "/dev/gpiochip%d", &chip) == 1 && chip >= 0 && chip < chipCount;
}
static bool DirectoryExists(const std::string& path) {
    struct stat info;
    return stat((root + path).c_str(), &info) == 0 && S_ISDIR(info.st_mode);
}
static std::string GetFileContents(const std::string&) { return ""; }
static void TrimWhiteSpace(std::string&) {}
static DIR* test_opendir(const char* path) { return opendir((root + path).c_str()); }
static char* test_realpath(const char* path, char* target) { return realpath((root + path).c_str(), target); }

namespace gpiod {
struct line {
    int chip;
    std::string name() const { return ""; }
    void release() {}
};
struct chip_info {
    int number;
    std::string label() const { return "gpio-" + std::to_string(number * 32) + "-" + std::to_string(number * 32 + 31); }
};
struct chip {
    int number;
    explicit chip(int n) : number(n) {}
    explicit chip(const std::string& path) : number(std::stoi(path.substr(13))) {}
    chip_info get_info() const { return { number }; }
    std::string label() const { return get_info().label(); }
    line get_line_info(int) const { return { number }; }
    line get_line(int) const { return { number }; }
};
static std::vector<chip> make_chip_iter() {
    std::vector<chip> chips;
    for (int n = 0; n < chipCount; n++) chips.emplace_back(n);
    return chips;
}
}

#define opendir test_opendir
#define realpath test_realpath
static void setupBBBMemoryMap();
#undef opendir
#undef realpath

int main(int argc, char** argv) {
    if (argc != 3) return 2;
    root = argv[1];
    chipCount = std::atoi(argv[2]);
    setupBBBMemoryMap();
    for (auto chip : bbGPIOMap) std::printf("%u ", chip);
    std::puts("");
    return 0;
}
