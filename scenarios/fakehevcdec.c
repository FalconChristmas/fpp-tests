/* A stand-in for the Pi's stateless V4L2 H.265 decoder, as a GStreamer plugin.
 *
 * The element is named v4l2slh265dec and outranks the software decoder, as the
 * real one does, so decodebin picks it unless fppd's autoplug-select hook skips
 * it.  If it is used at all it drops a marker file (FAKEHEVC_FILE) and fails
 * the stream, which is the real decoder's failure, minus the abort.
 *
 *   gcc -shared -fPIC -o libgstfakehevcdec.so fakehevcdec.c $(pkg-config --cflags --libs gstreamer-1.0)
 */
#define PACKAGE "fpp-tests"
#include <gst/gst.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { GstElement parent; GstPad *sink, *src; } FakeHevc;
typedef struct { GstElementClass parent; } FakeHevcClass;

G_DEFINE_TYPE(FakeHevc, fake_hevc, GST_TYPE_ELEMENT)

static GstStaticPadTemplate sink_t = GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-h265, stream-format=(string){hvc1,hev1,byte-stream}, alignment=(string)au"));
static GstStaticPadTemplate src_t = GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-raw, format=(string)I420"));

static GstFlowReturn chain(GstPad *pad, GstObject *parent, GstBuffer *buf) {
    const char *f = getenv("FAKEHEVC_FILE");
    if (f) {
        FILE *fp = fopen(f, "w");
        if (fp) fclose(fp);
    }
    gst_buffer_unref(buf);
    GST_ELEMENT_ERROR(parent, STREAM, DECODE, ("Driver did not accept the bitstream parameters"), (NULL));
    return GST_FLOW_ERROR;
}

static void fake_hevc_class_init(FakeHevcClass *k) {
    GstElementClass *e = GST_ELEMENT_CLASS(k);
    gst_element_class_add_static_pad_template(e, &sink_t);
    gst_element_class_add_static_pad_template(e, &src_t);
    gst_element_class_set_static_metadata(e, "Fake stateless H.265 decoder", "Codec/Decoder/Video/Hardware",
                                          "Stands in for v4l2slh265dec", "fpp-tests");
}

static void fake_hevc_init(FakeHevc *s) {
    s->sink = gst_pad_new_from_static_template(&sink_t, "sink");
    gst_pad_set_chain_function(s->sink, chain);
    gst_element_add_pad(GST_ELEMENT(s), s->sink);
    s->src = gst_pad_new_from_static_template(&src_t, "src");
    gst_element_add_pad(GST_ELEMENT(s), s->src);
}

static gboolean plugin_init(GstPlugin *p) {
    return gst_element_register(p, "v4l2slh265dec", GST_RANK_PRIMARY + 100, fake_hevc_get_type());
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, fakehevcdec, "stand-in v4l2slh265dec",
                  plugin_init, "1.0", "LGPL", PACKAGE, "https://example.invalid")
