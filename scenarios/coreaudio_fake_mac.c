/* coreaudio_fake_mac.dylib: DYLD_INSERT_LIBRARIES into a test fppd on macOS to
 * give its output-device lookup (MacOSUtils.cpp) audio devices of the
 * scenario's own, and keep its volume calls off the Mac's real ones.
 *
 * The system's device list is two devices, 1001 ("Other", the default
 * output) and 1002 ("FakeOut"). Each one's stream configuration
 * (kAudioDevicePropertyStreamConfiguration) has room for one AudioBuffer --
 * that is the size reported and the bytes written -- but claims
 * mNumberBuffers = 0x40000000, as a misbehaving driver's can: only a reader
 * that walks no further than the bytes it got survives it. Setting a
 * device's volume is logged to $COREAUDIO_FAKE_LOG ("set-volume <id>
 * <value>") and changes nothing; reading it answers 0.5. Everything else
 * goes to CoreAudio.
 */
#include <CoreAudio/CoreAudio.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INTERPOSE(replacement, replacee)                                                   \
    __attribute__((used)) static struct {                                                  \
        const void* r;                                                                     \
        const void* e;                                                                     \
    } interpose_##replacee __attribute__((section("__DATA,__interpose"))) = {              \
        (const void*)(unsigned long)&replacement, (const void*)(unsigned long)&replacee }

#define VOLUME 'vmvc'
#define STREAMS 'slay'

static const AudioObjectID DEVS[2] = { 1001, 1002 };

static void note(const char* fmt, AudioObjectID id, double v) {
    const char* path = getenv("COREAUDIO_FAKE_LOG");
    FILE* f = path ? fopen(path, "a") : NULL;
    if (f) {
        fprintf(f, fmt, (unsigned)id, v);
        fclose(f);
    }
}

static int ours(AudioObjectID id) {
    return id == DEVS[0] || id == DEVS[1];
}

static OSStatus g_size(AudioObjectID id, const AudioObjectPropertyAddress* a, UInt32 qs, const void* q, UInt32* out) {
    if (id == kAudioObjectSystemObject && a->mSelector == kAudioHardwarePropertyDevices) {
        *out = sizeof(DEVS);
        return 0;
    }
    if (ours(id)) {
        *out = a->mSelector == kAudioObjectPropertyName || a->mSelector == 'name' ? 256 : sizeof(Float32);
        return 0;
    }
    return AudioObjectGetPropertyDataSize(id, a, qs, q, out);
}
INTERPOSE(g_size, AudioObjectGetPropertyDataSize);

static OSStatus g_data(AudioObjectID id, const AudioObjectPropertyAddress* a, UInt32 qs, const void* q, UInt32* io, void* out) {
    if (id == kAudioObjectSystemObject && a->mSelector == kAudioHardwarePropertyDevices) {
        UInt32 n = *io < sizeof(DEVS) ? *io : sizeof(DEVS);
        memcpy(out, DEVS, n);
        *io = n;
        return 0;
    }
    if (id == kAudioObjectSystemObject && a->mSelector == kAudioHardwarePropertyDefaultOutputDevice) {
        *(AudioObjectID*)out = DEVS[0];
        *io = sizeof(AudioObjectID);
        return 0;
    }
    if (ours(id) && a->mSelector == 'name') {
        snprintf((char*)out, *io, "%s", id == DEVS[1] ? "FakeOut" : "Other");
        *io = (UInt32)strlen((char*)out) + 1;
        return 0;
    }
    if (ours(id) && a->mSelector == VOLUME) {
        *(Float32*)out = 0.5f;
        *io = sizeof(Float32);
        return 0;
    }
    return AudioObjectGetPropertyData(id, a, qs, q, io, out);
}
INTERPOSE(g_data, AudioObjectGetPropertyData);

static OSStatus g_set(AudioObjectID id, const AudioObjectPropertyAddress* a, UInt32 qs, const void* q, UInt32 n, const void* in) {
    if (a->mSelector == VOLUME) {
        note("set-volume %u %.2f\n", id, n >= sizeof(Float32) ? *(const Float32*)in : -1.0);
        return 0; /* never the Mac's real volume */
    }
    if (ours(id)) {
        return 0;
    }
    return AudioObjectSetPropertyData(id, a, qs, q, n, in);
}
INTERPOSE(g_set, AudioObjectSetPropertyData);

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static OSStatus g_info(AudioDeviceID id, UInt32 ch, Boolean in, AudioDevicePropertyID p, UInt32* size, Boolean* w) {
    if (ours(id) && p == STREAMS) {
        if (size) {
            *size = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
        }
        return 0;
    }
    return AudioDeviceGetPropertyInfo(id, ch, in, p, size, w);
}
INTERPOSE(g_info, AudioDeviceGetPropertyInfo);

static OSStatus g_get(AudioDeviceID id, UInt32 ch, Boolean in, AudioDevicePropertyID p, UInt32* size, void* out) {
    if (ours(id) && p == STREAMS) {
        UInt32 room = offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer);
        if (!size || *size < room) {
            return kAudioHardwareBadPropertySizeError;
        }
        AudioBufferList* l = (AudioBufferList*)out;
        l->mNumberBuffers = 0x40000000; /* what the driver claims */
        l->mBuffers[0].mNumberChannels = 2;
        l->mBuffers[0].mDataByteSize = 0;
        l->mBuffers[0].mData = NULL;
        *size = room; /* what it wrote */
        return 0;
    }
    return AudioDeviceGetProperty(id, ch, in, p, size, out);
}
INTERPOSE(g_get, AudioDeviceGetProperty);
#pragma clang diagnostic pop
