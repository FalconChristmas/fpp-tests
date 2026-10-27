/* alsapace.so: LD_PRELOAD into fppd to make an untimed ALSA PCM (the null
 * PCM behind AlsaFile's file device) take samples in real time, as a card
 * does: snd_pcm_writei() returns only once the frames written so far
 * would have played at the stream's rate. Without it the null PCM takes
 * everything at once and alsasink fills the file with silence as fast as
 * it can write.
 */
#define _GNU_SOURCE
#include <alsa/asoundlib.h>
#include <dlfcn.h>
#include <time.h>

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

snd_pcm_sframes_t snd_pcm_writei(snd_pcm_t* pcm, const void* buffer, snd_pcm_uframes_t size) {
    static snd_pcm_sframes_t (*real)(snd_pcm_t*, const void*, snd_pcm_uframes_t);
    static snd_pcm_t* current;
    static double start;
    static double frames;
    if (!real) {
        real = (snd_pcm_sframes_t(*)(snd_pcm_t*, const void*, snd_pcm_uframes_t))dlsym(RTLD_NEXT, "snd_pcm_writei");
    }
    snd_pcm_sframes_t n = real(pcm, buffer, size);
    unsigned int rate = 0;
    snd_pcm_hw_params_t* params;
    snd_pcm_hw_params_alloca(&params);
    if (n > 0 && snd_pcm_hw_params_current(pcm, params) == 0 &&
        snd_pcm_hw_params_get_rate(params, &rate, NULL) == 0 && rate > 0) {
        if (pcm != current) {
            current = pcm;
            start = now();
            frames = 0;
        }
        frames += n;
        double due = start + frames / rate;
        double wait = due - now();
        if (wait > 0) {
            struct timespec ts = { (time_t)wait, (long)((wait - (time_t)wait) * 1e9) };
            nanosleep(&ts, NULL);
        }
    }
    return n;
}
