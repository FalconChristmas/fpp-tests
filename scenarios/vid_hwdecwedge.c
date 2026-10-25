/* vid_hwdecwedge: a GStreamer plugin whose "hwdecwedge" stands in for a
 * hardware video decoder whose driver has died.  It claims VP8 (the test
 * videos' codec) as "Codec/Decoder/Video/Hardware", ranked above vp8dec so
 * decodebin chooses it.
 *
 * With HWDECWEDGE_WEDGE set, loading the plugin never returns.  The v4l2
 * plugin registers its decoders by opening each /dev/video* device in its
 * plugin_init, and on a Pi 4 whose bcm2835-codec oopsed with its mutex
 * held, that open() blocks for good.  decodebin knows the factory from the
 * registry cache and chooses it, but creating the element loads the plugin,
 * so no decoder ever appears in the pipeline.  Build the registry without
 * the variable (gst-inspect-1.0 with the same GST_REGISTRY_1_0) so fppd
 * doesn't scan, and so load, the plugin itself.
 *
 *   HWDECWEDGE_LOG   a line "load <process name>" is appended when the
 *                    plugin is loaded with HWDECWEDGE_WEDGE set, so a
 *                    scenario can tell fppd's decodebin chose it.
 *
 * Loaded by pointing GST_PLUGIN_PATH_1_0 at a directory holding it.
 */
#include <gst/gst.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define GST_TYPE_HW_DEC_WEDGE (gst_hw_dec_wedge_get_type())
G_DECLARE_FINAL_TYPE(GstHwDecWedge, gst_hw_dec_wedge, GST, HW_DEC_WEDGE, GstElement)

struct _GstHwDecWedge {
    GstElement parent;
};

G_DEFINE_TYPE(GstHwDecWedge, gst_hw_dec_wedge, GST_TYPE_ELEMENT)

static GstStaticPadTemplate sink_template =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-vp8"));
static GstStaticPadTemplate src_template =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-raw"));

static void gst_hw_dec_wedge_class_init(GstHwDecWedgeClass* klass) {
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    gst_element_class_add_static_pad_template(element_class, &sink_template);
    gst_element_class_add_static_pad_template(element_class, &src_template);
    gst_element_class_set_static_metadata(element_class, "Wedged hardware decoder", "Codec/Decoder/Video/Hardware",
                                          "fpp-tests stand-in for a dead V4L2 decoder", "fpp-tests");
}

static void gst_hw_dec_wedge_init(GstHwDecWedge* self) {
    gst_element_add_pad(GST_ELEMENT(self), gst_pad_new_from_static_template(&sink_template, "sink"));
    gst_element_add_pad(GST_ELEMENT(self), gst_pad_new_from_static_template(&src_template, "src"));
}

static gboolean plugin_init(GstPlugin* plugin) {
    if (getenv("HWDECWEDGE_WEDGE")) {
        const char* path = getenv("HWDECWEDGE_LOG");
        if (path) {
            char comm[32] = "?";
            FILE* c = fopen("/proc/self/comm", "r");
            if (c) {
                if (fgets(comm, sizeof(comm), c)) {
                    comm[strcspn(comm, "\n")] = 0;
                }
                fclose(c);
            }
            FILE* f = fopen(path, "a");
            if (f) {
                fprintf(f, "load %s\n", comm);
                fclose(f);
            }
        }
        for (;;) {
            sleep(3600);
        }
    }
    return gst_element_register(plugin, "hwdecwedge", GST_RANK_PRIMARY + 100, GST_TYPE_HW_DEC_WEDGE);
}

#define PACKAGE "fpp-tests"
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, vidhwdecwedge, "fpp-tests stand-in for a dead hardware decoder",
                  plugin_init, "1.0", "LGPL", "fpp-tests", "https://github.com/FalconChristmas/fpp-tests")
