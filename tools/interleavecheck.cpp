// Builds a panel interleave handler with FPP's own PanelInterleaveHandler
// (src/channeloutput/PanelInterleaveHandler.cpp of the tree under test) and
// prints how it maps the panel, for scenarios/test_output_panel_interleave.py.
//
//   interleavecheck TYPE WIDTH HEIGHT SCAN
//
// Prints "null" when createHandler() refuses the geometry, otherwise one
// line "x y -> x' y'" for every pixel of the upper half of the panel (the
// rows a scan addresses; the lower half mirrors them), in row order.
#include "channeloutput/PanelInterleaveHandler.h"

#include <cstdio>
#include <cstdlib>
#include <string>

int main(int argc, char* argv[]) {
    if (argc != 5) {
        fprintf(stderr, "usage: %s TYPE WIDTH HEIGHT SCAN\n", argv[0]);
        return 2;
    }
    int w = atoi(argv[2]);
    int h = atoi(argv[3]);
    int scan = atoi(argv[4]);
    PanelInterleaveHandler* handler = PanelInterleaveHandler::createHandler(argv[1], w, h, scan);
    if (!handler) {
        printf("null\n");
        return 0;
    }
    for (int y = 0; y < h / 2; y++) {
        for (int x = 0; x < w; x++) {
            int mx = x, my = y;
            handler->map(mx, my);
            printf("%d %d -> %d %d\n", x, y, mx, my);
        }
    }
    delete handler;
    return 0;
}
