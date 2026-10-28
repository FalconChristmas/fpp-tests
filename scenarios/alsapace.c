/* alsapace.so: LD_PRELOAD into fppd to make an untimed ALSA PCM (the null
 * PCM behind AlsaFile's file device) take samples in real time, as a card
 * does: snd_pcm_wait() returns only once the frames written so far would
 * have played at the stream's rate. Without it the null PCM takes
 * everything at once and alsasink fills the file with silence as fast as
 * it can write.
 *
 * The wait is where a card blocks, and alsasink calls it outside the lock
 * that snd_pcm_writei() and its clock's snd_pcm_delay() share. Pacing in
 * the write instead held that lock for each write's whole sleep, and
 * anything asking the sink's clock (fppd's main loop, through a position
 * query) waited behind it for seconds at a time. snd_pcm_writei() sleeps
 * only if it gets more than a card's buffer ahead, should a caller never
 * wait.
 */
#define _GNU_SOURCE
#include <alsa/asoundlib.h>
#include <dlfcn.h>
#include <time.h>

#define MAX_AHEAD 0.2

static snd_pcm_t* current;
static double start;
static double frames;
static unsigned int rate;

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void sleep_until(double due) {
    double wait = due - now();
    if (wait > 0) {
        struct timespec ts = { (time_t)wait, (long)((wait - (time_t)wait) * 1e9) };
        nanosleep(&ts, NULL);
    }
}

// When the frames written to pcm so far would have played, or 0 if pcm
// isn't the stream being paced.
static double due(snd_pcm_t* pcm) {
    return pcm == current && rate > 0 ? start + frames / rate : 0;
}

snd_pcm_sframes_t snd_pcm_writei(snd_pcm_t* pcm, const void* buffer, snd_pcm_uframes_t size) {
    static snd_pcm_sframes_t (*real)(snd_pcm_t*, const void*, snd_pcm_uframes_t);
    if (!real) {
        real = (snd_pcm_sframes_t(*)(snd_pcm_t*, const void*, snd_pcm_uframes_t))dlsym(RTLD_NEXT, "snd_pcm_writei");
    }
    snd_pcm_sframes_t n = real(pcm, buffer, size);
    unsigned int r = 0;
    snd_pcm_hw_params_t* params;
    snd_pcm_hw_params_alloca(&params);
    if (n > 0 && snd_pcm_hw_params_current(pcm, params) == 0 &&
        snd_pcm_hw_params_get_rate(params, &r, NULL) == 0 && r > 0) {
        if (pcm != current) {
            current = pcm;
            start = now();
            frames = 0;
        }
        rate = r;
        frames += n;
        sleep_until(due(pcm) - MAX_AHEAD);
    }
    return n;
}

int snd_pcm_wait(snd_pcm_t* pcm, int timeout) {
    static int (*real)(snd_pcm_t*, int);
    if (!real) {
        real = (int (*)(snd_pcm_t*, int))dlsym(RTLD_NEXT, "snd_pcm_wait");
    }
    sleep_until(due(pcm));
    return real(pcm, timeout);
}
