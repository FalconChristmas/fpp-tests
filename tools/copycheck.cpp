// Copies SRC to DEST with FPP's own CopyFileContents() (src/common_mini.cpp
// of the tree under test, through libfpp) and prints what it returned, "1"
// or "0", for scenarios/test_copy_file_contents.py.
//
//   copycheck SRC DEST
#include "common_mini.h"

#include <cstdio>

// libfpp.so takes this one symbol from fppd's executable (see fseqgen.cpp).
volatile int runMainFPPDLoop = 1;

int main(int argc, char* argv[]) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s SRC DEST\n", argv[0]);
        return 2;
    }
    printf("%d\n", CopyFileContents(argv[1], argv[2]) ? 1 : 0);
    return 0;
}
