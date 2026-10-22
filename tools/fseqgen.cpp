// Write an FSEQ file with FPP's own writer (FSEQFile from the tree under
// test), so every scenario that plays a sequence also exercises the writer.
//
//   fseqgen OUT VERSION COMPRESSION LEVEL STEP_MS CHANNEL_SPACE
//           [--minor N] [--sparse START:COUNT[,START:COUNT...]] [--media NAME]
//           < frames
//
// stdin holds the frames back to back, CHANNEL_SPACE bytes each, indexed by
// absolute channel (0-based), as fppd's channel data is. With --sparse the
// writer keeps only those ranges, as fsequtils does.
// COMPRESSION is none, zstd or zlib; LEVEL -99 means the writer's default.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "fseq/FSEQFile.h"

// libfpp.so takes this one symbol from fppd's executable. Defining it lets
// the helper link the real library, so the writer runs exactly as built.
volatile int runMainFPPDLoop = 1;

static void usage() {
    fprintf(stderr, "usage: fseqgen OUT VERSION none|zstd|zlib LEVEL STEP_MS CHANNEL_SPACE "
                    "[--minor N] [--sparse S:C,...] [--media NAME] < frames\n");
    exit(2);
}

int main(int argc, char** argv) {
    if (argc < 7) {
        usage();
    }
    std::string out = argv[1];
    int version = atoi(argv[2]);
    std::string comp = argv[3];
    int level = atoi(argv[4]);
    int step = atoi(argv[5]);
    uint32_t space = (uint32_t)strtoul(argv[6], nullptr, 10);
    int minor = -1;
    std::vector<std::pair<uint32_t, uint32_t>> sparse;
    std::string media;
    for (int i = 7; i < argc; i++) {
        if (!strcmp(argv[i], "--minor") && i + 1 < argc) {
            minor = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--sparse") && i + 1 < argc) {
            std::string list = argv[++i];
            size_t pos = 0;
            while (pos < list.size()) {
                size_t comma = list.find(',', pos);
                std::string item = list.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
                size_t colon = item.find(':');
                if (colon == std::string::npos) {
                    usage();
                }
                sparse.emplace_back((uint32_t)strtoul(item.c_str(), nullptr, 10),
                                    (uint32_t)strtoul(item.c_str() + colon + 1, nullptr, 10));
                pos = comma == std::string::npos ? list.size() : comma + 1;
            }
        } else if (!strcmp(argv[i], "--media") && i + 1 < argc) {
            media = argv[++i];
        } else {
            usage();
        }
    }
    FSEQFile::CompressionType ct = FSEQFile::CompressionType::none;
    if (comp == "zstd") {
        ct = FSEQFile::CompressionType::zstd;
    } else if (comp == "zlib") {
        ct = FSEQFile::CompressionType::zlib;
    } else if (comp != "none") {
        usage();
    }

    std::vector<uint8_t> all;
    std::vector<uint8_t> buf(65536);
    size_t n;
    while ((n = fread(buf.data(), 1, buf.size(), stdin)) > 0) {
        all.insert(all.end(), buf.begin(), buf.begin() + n);
    }
    if (space == 0 || all.size() % space) {
        fprintf(stderr, "fseqgen: %zu bytes of input is not a whole number of %u-channel frames\n",
                all.size(), space);
        return 1;
    }
    uint32_t frames = (uint32_t)(all.size() / space);

    FSEQFile* f = FSEQFile::createFSEQFile(out, version, ct, level);
    if (!f) {
        fprintf(stderr, "fseqgen: createFSEQFile failed for %s\n", out.c_str());
        return 1;
    }
    if (minor >= 0) {
        f->enableMinorVersionFeatures(minor);
    }
    if (!sparse.empty()) {
        if (version != 2) {
            fprintf(stderr, "fseqgen: sparse ranges need version 2\n");
            return 1;
        }
        ((V2FSEQFile*)f)->m_sparseRanges = sparse;
    }
    // The whole channel space, sparse or not: writeHeader() clips each range
    // to it and then sets the stored count to the ranges' total itself.
    f->setChannelCount(space);
    f->setNumFrames(frames);
    f->setStepTime(step);
    if (!media.empty()) {
        FSEQFile::VariableHeader vh;
        vh.code[0] = 'm';
        vh.code[1] = 'f';
        vh.resizeData(media.size() + 1);
        memcpy(vh.getData().data(), media.c_str(), media.size() + 1);
        f->addVariableHeader(vh);
    }
    f->writeHeader();
    for (uint32_t i = 0; i < frames; i++) {
        f->addFrame(i, &all[(size_t)i * space]);
    }
    f->finalize();
    delete f;
    return 0;
}
