/* fakekms: a GStreamer plugin whose "kmssink" stands in for the real one,
 * which fails at READY in a container (no DRM device).  It takes the real
 * sink's properties, accepts any raw video, renders nothing and records
 * what it was asked to do, so a scenario can follow fppd's display outputs:
 *
 *   FAKEKMS_LOG         lines "<event> <element name> <connector-id> <monotonic s>",
 *                       event start, frame or stop, appended per event.
 *   FAKEKMS_FAIL_AFTER  n: after n frames, post an error and return
 *                       GST_FLOW_ERROR, as a display that went away does.
 *   FAKEKMS_SETPLANE    "1": put each frame on the sink's plane with
 *                       drmModeSetPlane() on its fd, as the real sink does --
 *                       scaled to fit the connector's mode, and on failure
 *                       once more unscaled, centred, before giving up with
 *                       the real sink's error.  For a fake card (fakedrm.c)
 *                       to see the plane: the frame is a framebuffer of the
 *                       negotiated format and size, with nothing in it.
 *   FAKEKMS_POOL        "1": answer the allocation query with a pool of the
 *                       sink's own, as the real sink does, whose every buffer
 *                       has a dumb buffer on the sink's fd (the display's
 *                       lease), destroyed with DESTROY_DUMB on that fd when
 *                       the buffer is freed.  FAKEKMS_LOG gets "alloc pool
 *                       <connector-id> <s>" for each buffer the pool makes,
 *                       and "lostdumb pool <connector-id> <s>" for each
 *                       DESTROY_DUMB that fails (its fd closed under it).
 *
 * Loaded by pointing GST_PLUGIN_SYSTEM_PATH_1_0 at a directory holding it
 * and every system plugin except libgstkms.so (video.fake_kms_env()).
 */
#include <drm_fourcc.h>
#include <errno.h>
#include <gst/base/gstbasesink.h>
#include <gst/gst.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define GST_TYPE_FAKE_KMS (gst_fake_kms_get_type())
G_DECLARE_FINAL_TYPE(GstFakeKms, gst_fake_kms, GST, FAKE_KMS, GstBaseSink)

struct _GstFakeKms {
    GstBaseSink parent;
    gint connector_id;
    gint plane_id;
    gint fd;
    gchar* driver_name;
    gchar* bus_id;
    gboolean restore_crtc;
    gboolean skip_vsync;
    gboolean force_modesetting;
    gboolean can_scale;
    guint frames;
    // FAKEKMS_SETPLANE: the negotiated frame, and its framebuffer on fd.
    guint32 format;
    gint width, height;
    guint32 fb_id;
};

G_DEFINE_TYPE(GstFakeKms, gst_fake_kms, GST_TYPE_BASE_SINK)

enum {
    PROP_0,
    PROP_CONNECTOR_ID,
    PROP_PLANE_ID,
    PROP_FD,
    PROP_DRIVER_NAME,
    PROP_BUS_ID,
    PROP_RESTORE_CRTC,
    PROP_SKIP_VSYNC,
    PROP_FORCE_MODESETTING,
    PROP_CAN_SCALE,
};

static GstStaticPadTemplate sink_template =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-raw"));

static void record(GstFakeKms* self, const char* event) {
    const char* path = getenv("FAKEKMS_LOG");
    if (!path) {
        return;
    }
    FILE* f = fopen(path, "a");
    if (!f) {
        return;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    gchar* name = gst_object_get_name(GST_OBJECT(self));
    fprintf(f, "%s %s %d %ld.%03ld\n", event, name ? name : "?", self->connector_id,
            (long)ts.tv_sec, ts.tv_nsec / 1000000);
    g_free(name);
    fclose(f);
}

static void record_pool(gint connector_id, const char* event) {
    const char* path = getenv("FAKEKMS_LOG");
    FILE* f = path ? fopen(path, "a") : NULL;
    if (!f) {
        return;
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    fprintf(f, "%s pool %d %ld.%03ld\n", event, connector_id, (long)ts.tv_sec, ts.tv_nsec / 1000000);
    fclose(f);
}

/* FAKEKMS_POOL: buffers of system memory, each with a dumb buffer on the
 * fd the sink was given, as the real sink's dumb-buffer allocator makes. */
#define FAKE_TYPE_KMS_POOL (fake_kms_pool_get_type())
G_DECLARE_FINAL_TYPE(FakeKmsPool, fake_kms_pool, FAKE, KMS_POOL, GstBufferPool)

struct _FakeKmsPool {
    GstBufferPool parent;
    gint fd;
    gint connector_id;
};

G_DEFINE_TYPE(FakeKmsPool, fake_kms_pool, GST_TYPE_BUFFER_POOL)

static GQuark dumb_quark(void) {
    return g_quark_from_static_string("fakekms-dumb");
}

static GstFlowReturn fake_kms_pool_alloc(GstBufferPool* pool, GstBuffer** buffer, GstBufferPoolAcquireParams* params) {
    FakeKmsPool* self = FAKE_KMS_POOL(pool);
    GstFlowReturn ret = GST_BUFFER_POOL_CLASS(fake_kms_pool_parent_class)->alloc_buffer(pool, buffer, params);
    if (ret != GST_FLOW_OK) {
        return ret;
    }
    struct drm_mode_create_dumb c = { .height = 1, .width = (guint32)gst_buffer_get_size(*buffer), .bpp = 8 };
    if (drmIoctl(self->fd, DRM_IOCTL_MODE_CREATE_DUMB, &c) == 0) {
        gst_mini_object_set_qdata(GST_MINI_OBJECT(*buffer), dumb_quark(), GUINT_TO_POINTER(c.handle), NULL);
    }
    record_pool(self->connector_id, "alloc");
    return GST_FLOW_OK;
}

static void fake_kms_pool_free(GstBufferPool* pool, GstBuffer* buffer) {
    FakeKmsPool* self = FAKE_KMS_POOL(pool);
    guint handle = GPOINTER_TO_UINT(gst_mini_object_get_qdata(GST_MINI_OBJECT(buffer), dumb_quark()));
    if (handle) {
        struct drm_mode_destroy_dumb d = { .handle = handle };
        if (drmIoctl(self->fd, DRM_IOCTL_MODE_DESTROY_DUMB, &d)) {
            record_pool(self->connector_id, "lostdumb");
        }
    }
    GST_BUFFER_POOL_CLASS(fake_kms_pool_parent_class)->free_buffer(pool, buffer);
}

static void fake_kms_pool_class_init(FakeKmsPoolClass* klass) {
    GstBufferPoolClass* pool = GST_BUFFER_POOL_CLASS(klass);
    pool->alloc_buffer = fake_kms_pool_alloc;
    pool->free_buffer = fake_kms_pool_free;
}

static void fake_kms_pool_init(FakeKmsPool* self) {
    self->fd = -1;
}

static gboolean gst_fake_kms_propose_allocation(GstBaseSink* sink, GstQuery* query) {
    GstFakeKms* self = GST_FAKE_KMS(sink);
    const char* want = getenv("FAKEKMS_POOL");
    GstCaps* caps = NULL;
    gboolean need_pool = FALSE;
    gst_query_parse_allocation(query, &caps, &need_pool);
    if (!want || strcmp(want, "1") || self->fd < 0 || !caps) {
        return FALSE;
    }
    FakeKmsPool* pool = g_object_new(FAKE_TYPE_KMS_POOL, NULL);
    pool->fd = self->fd;
    pool->connector_id = self->connector_id;
    gst_query_add_allocation_pool(query, GST_BUFFER_POOL(pool), 0, 2, 0);
    gst_object_unref(pool);
    return TRUE;
}

static gboolean gst_fake_kms_start(GstBaseSink* sink) {
    GstFakeKms* self = GST_FAKE_KMS(sink);
    self->frames = 0;
    record(self, "start");
    // a real kmssink without skip-vsync reads page-flip events off its fd
    record(self, self->skip_vsync ? "skipvsync" : "waitvsync");
    return TRUE;
}

static gboolean gst_fake_kms_stop(GstBaseSink* sink) {
    record(GST_FAKE_KMS(sink), "stop");
    return TRUE;
}

static guint32 drm_format(const gchar* f) {
    if (!f) return DRM_FORMAT_XRGB8888;
    if (!strcmp(f, "I420")) return DRM_FORMAT_YUV420;
    if (!strcmp(f, "YV12")) return DRM_FORMAT_YVU420;
    if (!strcmp(f, "NV12")) return DRM_FORMAT_NV12;
    if (!strcmp(f, "NV21")) return DRM_FORMAT_NV21;
    if (!strcmp(f, "RGB16")) return DRM_FORMAT_RGB565;
    if (!strcmp(f, "RGB") || !strcmp(f, "BGR")) return DRM_FORMAT_RGB888;
    return DRM_FORMAT_XRGB8888;
}

static gboolean gst_fake_kms_set_caps(GstBaseSink* sink, GstCaps* caps) {
    GstFakeKms* self = GST_FAKE_KMS(sink);
    GstStructure* s = gst_caps_get_structure(caps, 0);
    self->format = drm_format(gst_structure_get_string(s, "format"));
    gst_structure_get_int(s, "width", &self->width);
    gst_structure_get_int(s, "height", &self->height);
    self->fb_id = 0;  // a new one for the new shape, on the next frame
    return TRUE;
}

// The real sink's drmModeSetPlane(): the frame fitted to the mode keeping its
// shape, or where the driver refused that, at its own size in the middle.
static gboolean show_frame(GstFakeKms* self) {
    drmModeConnectorPtr conn = drmModeGetConnector(self->fd, (uint32_t)self->connector_id);
    if (!conn || !conn->count_modes || !conn->encoder_id) {
        if (conn) drmModeFreeConnector(conn);
        errno = ENODEV;
        return FALSE;
    }
    gint dw = conn->modes[0].hdisplay, dh = conn->modes[0].vdisplay;
    drmModeEncoderPtr enc = drmModeGetEncoder(self->fd, conn->encoder_id);
    drmModeFreeConnector(conn);
    guint32 crtc = enc ? enc->crtc_id : 0;
    if (enc) drmModeFreeEncoder(enc);
    if (!self->fb_id) {
        guint32 handles[4] = { 1, 1, 1, 0 }, pitches[4] = { 0 }, offsets[4] = { 0 };
        if (drmModeAddFB2(self->fd, self->width, self->height, self->format, handles, pitches, offsets,
                          &self->fb_id, 0)) {
            return FALSE;
        }
    }
    for (;;) {
        gint w = self->width, h = self->height;
        if (self->can_scale) {
            if ((gint64)w * dh > (gint64)h * dw) {
                h = (gint)((gint64)h * dw / w), w = dw;
            } else {
                w = (gint)((gint64)w * dh / h), h = dh;
            }
        } else {
            w = MIN(w, dw), h = MIN(h, dh);
        }
        gint sw = self->can_scale ? self->width : w, sh = self->can_scale ? self->height : h;
        if (!drmModeSetPlane(self->fd, (uint32_t)self->plane_id, crtc, self->fb_id, 0, (dw - w) / 2, (dh - h) / 2,
                             w, h, 0, 0, (uint32_t)sw << 16, (uint32_t)sh << 16)) {
            return TRUE;
        }
        if (!self->can_scale) {
            return FALSE;
        }
        self->can_scale = FALSE;
    }
}

static GstFlowReturn gst_fake_kms_render(GstBaseSink* sink, GstBuffer* buf) {
    GstFakeKms* self = GST_FAKE_KMS(sink);
    const char* fail = getenv("FAKEKMS_FAIL_AFTER");
    const char* setplane = getenv("FAKEKMS_SETPLANE");
    (void)buf;
    if (fail && self->frames >= (guint)atoi(fail)) {
        GST_ELEMENT_ERROR(self, RESOURCE, WRITE, ("fakekms: display gone"), (NULL));
        return GST_FLOW_ERROR;
    }
    if (setplane && !strcmp(setplane, "1") && self->fd >= 0 && self->plane_id > 0 && !show_frame(self)) {
        int err = errno;
        record(self, "refused");
        GST_ELEMENT_ERROR(self, RESOURCE, FAILED, (NULL),
                          ("drmModeSetPlane failed: %s (%d)", g_strerror(err), err));
        return GST_FLOW_ERROR;
    }
    self->frames++;
    record(self, "frame");
    return GST_FLOW_OK;
}

static void gst_fake_kms_set_property(GObject* object, guint id, const GValue* value, GParamSpec* pspec) {
    GstFakeKms* self = GST_FAKE_KMS(object);
    switch (id) {
    case PROP_CONNECTOR_ID: self->connector_id = g_value_get_int(value); break;
    case PROP_PLANE_ID: self->plane_id = g_value_get_int(value); break;
    case PROP_FD: self->fd = g_value_get_int(value); break;
    case PROP_DRIVER_NAME: g_free(self->driver_name); self->driver_name = g_value_dup_string(value); break;
    case PROP_BUS_ID: g_free(self->bus_id); self->bus_id = g_value_dup_string(value); break;
    case PROP_RESTORE_CRTC: self->restore_crtc = g_value_get_boolean(value); break;
    case PROP_SKIP_VSYNC: self->skip_vsync = g_value_get_boolean(value); break;
    case PROP_FORCE_MODESETTING: self->force_modesetting = g_value_get_boolean(value); break;
    case PROP_CAN_SCALE: self->can_scale = g_value_get_boolean(value); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec); break;
    }
}

static void gst_fake_kms_get_property(GObject* object, guint id, GValue* value, GParamSpec* pspec) {
    GstFakeKms* self = GST_FAKE_KMS(object);
    switch (id) {
    case PROP_CONNECTOR_ID: g_value_set_int(value, self->connector_id); break;
    case PROP_PLANE_ID: g_value_set_int(value, self->plane_id); break;
    case PROP_FD: g_value_set_int(value, self->fd); break;
    case PROP_DRIVER_NAME: g_value_set_string(value, self->driver_name); break;
    case PROP_BUS_ID: g_value_set_string(value, self->bus_id); break;
    case PROP_RESTORE_CRTC: g_value_set_boolean(value, self->restore_crtc); break;
    case PROP_SKIP_VSYNC: g_value_set_boolean(value, self->skip_vsync); break;
    case PROP_FORCE_MODESETTING: g_value_set_boolean(value, self->force_modesetting); break;
    case PROP_CAN_SCALE: g_value_set_boolean(value, self->can_scale); break;
    default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec); break;
    }
}

static void gst_fake_kms_finalize(GObject* object) {
    GstFakeKms* self = GST_FAKE_KMS(object);
    g_free(self->driver_name);
    g_free(self->bus_id);
    G_OBJECT_CLASS(gst_fake_kms_parent_class)->finalize(object);
}

static void gst_fake_kms_class_init(GstFakeKmsClass* klass) {
    GObjectClass* gobject = G_OBJECT_CLASS(klass);
    GstElementClass* element = GST_ELEMENT_CLASS(klass);
    GstBaseSinkClass* base = GST_BASE_SINK_CLASS(klass);
    const GParamFlags rw = G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS;

    gobject->set_property = gst_fake_kms_set_property;
    gobject->get_property = gst_fake_kms_get_property;
    gobject->finalize = gst_fake_kms_finalize;
    g_object_class_install_property(gobject, PROP_CONNECTOR_ID,
        g_param_spec_int("connector-id", "Connector ID", "DRM connector id", -1, G_MAXINT32, -1, rw));
    g_object_class_install_property(gobject, PROP_PLANE_ID,
        g_param_spec_int("plane-id", "Plane ID", "DRM plane id", -1, G_MAXINT32, -1, rw));
    g_object_class_install_property(gobject, PROP_FD,
        g_param_spec_int("fd", "File Descriptor", "DRM file descriptor", -1, G_MAXINT, -1, rw));
    g_object_class_install_property(gobject, PROP_DRIVER_NAME,
        g_param_spec_string("driver-name", "Driver Name", "DRM driver name", NULL, rw));
    g_object_class_install_property(gobject, PROP_BUS_ID,
        g_param_spec_string("bus-id", "Bus ID", "DRM bus id", NULL, rw));
    g_object_class_install_property(gobject, PROP_RESTORE_CRTC,
        g_param_spec_boolean("restore-crtc", "Restore CRTC", "Restore the CRTC on exit", TRUE, rw));
    g_object_class_install_property(gobject, PROP_SKIP_VSYNC,
        g_param_spec_boolean("skip-vsync", "Skip VSync", "Don't wait for vsync", FALSE, rw));
    g_object_class_install_property(gobject, PROP_FORCE_MODESETTING,
        g_param_spec_boolean("force-modesetting", "Force modesetting", "Set the mode", FALSE, rw));
    g_object_class_install_property(gobject, PROP_CAN_SCALE,
        g_param_spec_boolean("can-scale", "Can scale", "The plane can scale", TRUE, rw));

    gst_element_class_set_static_metadata(element, "Fake KMS video sink", "Sink/Video",
                                          "Records what a KMS sink would show (fpp-tests)", "fpp-tests");
    gst_element_class_add_static_pad_template(element, &sink_template);
    base->start = gst_fake_kms_start;
    base->stop = gst_fake_kms_stop;
    base->render = gst_fake_kms_render;
    base->set_caps = gst_fake_kms_set_caps;
    base->propose_allocation = gst_fake_kms_propose_allocation;
}

static void gst_fake_kms_init(GstFakeKms* self) {
    self->connector_id = -1;
    self->plane_id = -1;
    self->fd = -1;
    self->restore_crtc = TRUE;
    self->can_scale = TRUE;
}

static gboolean plugin_init(GstPlugin* plugin) {
    return gst_element_register(plugin, "kmssink", GST_RANK_SECONDARY, GST_TYPE_FAKE_KMS);
}

#define PACKAGE "fpp-tests"
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, fakekms, "fpp-tests stand-in for kmssink",
                  plugin_init, "1.0", "LGPL", "fpp-tests", "https://github.com/FalconChristmas/fpp-tests")
