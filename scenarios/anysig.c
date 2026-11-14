/* anysig.so: LD_PRELOAD into fppcapedetect (or fppd) to make a cape EEPROM's
 * signature check pass without a vendor's private key, so a scenario can
 * build a "signed" image and test what CapeUtils does with one: which key
 * ids it accepts, the records only a signed image may use, and the checks
 * that still turn a good signature down.
 *
 * CapeUtils verifies a type-99 record by decoding the key id's public key
 * from its built-in table (KEYS) with OSSL_DECODER_from_data, then
 * EVP_DigestVerifyInit/Update/Final over the records after it. Only the last
 * step is answered here: EVP_DigestVerifyFinal returns 1 ("verified"). A key
 * id the table doesn't have still fails, at the decode, so the table is
 * still what decides which key ids count.
 *
 * ANYSIG_LOG=<file>: each EVP_DigestVerifyFinal call appends "verify" and
 * the signature length.
 */
#define _GNU_SOURCE
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct evp_md_ctx_st EVP_MD_CTX;

int EVP_DigestVerifyFinal(EVP_MD_CTX* ctx, const unsigned char* sig, size_t siglen) {
    (void)ctx;
    (void)sig;
    const char* log = getenv("ANYSIG_LOG");
    if (log) {
        FILE* f = fopen(log, "a");
        if (f) {
            fprintf(f, "verify %zu\n", siglen);
            fclose(f);
        }
    }
    return 1;
}
