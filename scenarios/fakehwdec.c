/* fakehwdec: a GStreamer plugin whose VP8 decoder hands out its frames as a
 * hardware decoder does -- in device memory (dmabuf, here a memfd), laid
 * out with padded rows, the layout given only by a GstVideoMeta.  Inside,
 * it is the real vp8dec; each I420 frame it decodes is copied into a
 * dmabuf whose rows are FAKEHWDEC_PAD bytes (default 64) longer than the
 * picture, the padding filled with 0.  Read with the caps' default layout
 * instead of the meta's, the picture shears.
 *
 * Ranked above vp8dec, so decodebin picks it.  Loaded like fakekms.c, from
 * a plugin directory GST_PLUGIN_SYSTEM_PATH_1_0 points at.  Each frame it
 * hands out appends "frame <width>x<height> stride <n>" to FAKEHWDEC_LOG,
 * if set.
 */
#define _GNU_SOURCE
#define PACKAGE "fpp-tests"
#include <gst/allocators/gstdmabuf.h>
#include <gst/gst.h>
#include <gst/video/video.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define GST_TYPE_FAKE_HW_DEC (gst_fake_hw_dec_get_type())
G_DECLARE_FINAL_TYPE(GstFakeHwDec, gst_fake_hw_dec, GST, FAKE_HW_DEC, GstBin)

struct _GstFakeHwDec {
    GstBin parent;
    GstAllocator* dmabuf;
    GstVideoInfo info;
    gboolean have_info;
};

G_DEFINE_TYPE(GstFakeHwDec, gst_fake_hw_dec, GST_TYPE_BIN)

static GstStaticPadTemplate sink_template =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-vp8"));
static GstStaticPadTemplate src_template = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-raw, format=(string)I420"));

static GstBuffer* to_device(GstFakeHwDec* self, GstBuffer* in) {
    GstVideoFrame frame;
    if (!gst_video_frame_map(&frame, &self->info, in, GST_MAP_READ)) {
        return NULL;
    }
    const char* padenv = getenv("FAKEHWDEC_PAD");
    int pad = padenv ? atoi(padenv) : 64;
    int w = GST_VIDEO_INFO_WIDTH(&self->info), h = GST_VIDEO_INFO_HEIGHT(&self->info);
    gsize offset[GST_VIDEO_MAX_PLANES] = { 0 };
    gint stride[GST_VIDEO_MAX_PLANES] = { 0 };
    gsize size = 0;
    for (int p = 0; p < 3; p++) {
        int pw = GST_VIDEO_FRAME_COMP_WIDTH(&frame, p), ph = GST_VIDEO_FRAME_COMP_HEIGHT(&frame, p);
        stride[p] = pw + (p ? pad / 2 : pad);
        offset[p] = size;
        size += (gsize)stride[p] * ph;
    }
    int fd = memfd_create("fakehwdec", MFD_CLOEXEC);
    if (fd < 0 || ftruncate(fd, size) < 0) {
        gst_video_frame_unmap(&frame);
        return NULL;
    }
    guint8* dst = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    memset(dst, 0, size);
    for (int p = 0; p < 3; p++) {
        const guint8* src = GST_VIDEO_FRAME_PLANE_DATA(&frame, p);
        int sstride = GST_VIDEO_FRAME_PLANE_STRIDE(&frame, p);
        int pw = GST_VIDEO_FRAME_COMP_WIDTH(&frame, p), ph = GST_VIDEO_FRAME_COMP_HEIGHT(&frame, p);
        for (int y = 0; y < ph; y++) {
            memcpy(dst + offset[p] + (gsize)y * stride[p], src + (gsize)y * sstride, pw);
        }
    }
    munmap(dst, size);
    gst_video_frame_unmap(&frame);

    GstBuffer* out = gst_buffer_new();
    gst_buffer_append_memory(out, gst_dmabuf_allocator_alloc(self->dmabuf, fd, size));
    gst_buffer_copy_into(out, in, (GstBufferCopyFlags)(GST_BUFFER_COPY_FLAGS | GST_BUFFER_COPY_TIMESTAMPS), 0, -1);
    gst_buffer_add_video_meta_full(out, GST_VIDEO_FRAME_FLAG_NONE, GST_VIDEO_FORMAT_I420, w, h, 3, offset,
                                   stride);
    const char* log = getenv("FAKEHWDEC_LOG");
    FILE* f = log ? fopen(log, "a") : NULL;
    if (f) {
        fprintf(f, "frame %dx%d stride %d\n", w, h, stride[0]);
        fclose(f);
    }
    return out;
}

static GstPadProbeReturn on_frame(GstPad* pad, GstPadProbeInfo* info, gpointer data) {
    GstFakeHwDec* self = GST_FAKE_HW_DEC(data);
    if (info->type & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
        GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
        if (GST_EVENT_TYPE(ev) == GST_EVENT_CAPS) {
            GstCaps* caps;
            gst_event_parse_caps(ev, &caps);
            self->have_info = gst_video_info_from_caps(&self->info, caps);
        }
        return GST_PAD_PROBE_OK;
    }
    GstBuffer* in = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!in || !self->have_info) {
        return GST_PAD_PROBE_OK;
    }
    GstBuffer* out = to_device(self, in);
    if (out) {
        gst_buffer_unref(in);
        GST_PAD_PROBE_INFO_DATA(info) = out;
    }
    return GST_PAD_PROBE_OK;
}

static void gst_fake_hw_dec_init(GstFakeHwDec* self) {
    self->dmabuf = gst_dmabuf_allocator_new();
    GstElement* dec = gst_element_factory_make("vp8dec", "realdec");
    GstElement* filter = gst_element_factory_make("capsfilter", "i420");
    GstCaps* caps = gst_caps_from_string("video/x-raw,format=I420");
    g_object_set(filter, "caps", caps, NULL);
    gst_caps_unref(caps);
    gst_bin_add_many(GST_BIN(self), dec, filter, NULL);
    gst_element_link(dec, filter);
    GstPad* sink = gst_element_get_static_pad(dec, "sink");
    GstPad* src = gst_element_get_static_pad(filter, "src");
    gst_pad_add_probe(src, GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM, on_frame, self, NULL);
    gst_element_add_pad(GST_ELEMENT(self), gst_ghost_pad_new_from_template(
                                               "sink", sink, gst_static_pad_template_get(&sink_template)));
    gst_element_add_pad(GST_ELEMENT(self), gst_ghost_pad_new_from_template(
                                               "src", src, gst_static_pad_template_get(&src_template)));
    gst_object_unref(sink);
    gst_object_unref(src);
}

static void gst_fake_hw_dec_finalize(GObject* obj) {
    gst_object_unref(GST_FAKE_HW_DEC(obj)->dmabuf);
    G_OBJECT_CLASS(gst_fake_hw_dec_parent_class)->finalize(obj);
}

static void gst_fake_hw_dec_class_init(GstFakeHwDecClass* klass) {
    G_OBJECT_CLASS(klass)->finalize = gst_fake_hw_dec_finalize;
    GstElementClass* ec = GST_ELEMENT_CLASS(klass);
    gst_element_class_add_static_pad_template(ec, &sink_template);
    gst_element_class_add_static_pad_template(ec, &src_template);
    /* FAKEHWDEC_HARDWARE=1 files it as a hardware decoder, as the V4L2 ones are */
    gst_element_class_set_static_metadata(ec, "Fake device-memory VP8 decoder",
                                          getenv("FAKEHWDEC_HARDWARE") ? "Codec/Decoder/Video/Hardware" : "Codec/Decoder/Video",
                                          "vp8dec, its frames moved into padded dmabufs", "fpp-tests");
}

static gboolean plugin_init(GstPlugin* plugin) {
    return gst_element_register(plugin, "fakehwdec", GST_RANK_PRIMARY + 100, GST_TYPE_FAKE_HW_DEC);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, fakehwdec, "fpp-tests fake device-memory decoder",
                  plugin_init, "1.0", "LGPL", "fpp-tests", "https://github.com/FalconChristmas/fpp")
