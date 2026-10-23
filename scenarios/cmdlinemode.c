/* cmdlinemode.so: LD_PRELOAD into fppd to make one connector look as it does
 * with video=<connector>:1280x720@60e on the kernel command line -- what
 * the Force HDMI Resolution settings write -- without a reboot.
 *
 * drmModeGetConnector() and drmModeGetConnectorCurrent() for the connector
 * CMDLINEMODE_CONNECTOR_ID come back "connected" (the 'e') with a 1280x720@60
 * mode flagged DRM_MODE_TYPE_USERDEF, as the kernel's
 * drm_helper_probe_add_cmdline_mode() flags it. With CMDLINEMODE_EDID=1 the
 * connector also has an EDID, from a display whose preferred mode is
 * 1920x1080@60, listed first.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xf86drmMode.h>

static drmModeModeInfo cea(int w, int h, uint32_t clock, int hs, int he, int ht, int vs, int ve, int vt, uint32_t type) {
    drmModeModeInfo m;
    memset(&m, 0, sizeof(m));
    m.clock = clock;
    m.hdisplay = w;
    m.hsync_start = hs;
    m.hsync_end = he;
    m.htotal = ht;
    m.vdisplay = h;
    m.vsync_start = vs;
    m.vsync_end = ve;
    m.vtotal = vt;
    m.vrefresh = 60;
    m.flags = DRM_MODE_FLAG_PHSYNC | DRM_MODE_FLAG_PVSYNC;
    m.type = DRM_MODE_TYPE_DRIVER | type;
    snprintf(m.name, sizeof(m.name), "%dx%d", w, h);
    return m;
}

static drmModeConnectorPtr fake(int fd, drmModeConnectorPtr conn) {
    const char* id = getenv("CMDLINEMODE_CONNECTOR_ID");
    if (!conn || !id || conn->connector_id != (uint32_t)atoi(id)) {
        return conn;
    }
    const char* e = getenv("CMDLINEMODE_EDID");
    int edid = e && atoi(e);
    drmModeModeInfo* modes = calloc(2, sizeof(drmModeModeInfo));
    int n = 0;
    if (edid) {
        modes[n++] = cea(1920, 1080, 148500, 2008, 2052, 2200, 1084, 1089, 1125, DRM_MODE_TYPE_PREFERRED);
        for (int i = 0; i < conn->count_props; i++) {
            drmModePropertyPtr prop = drmModeGetProperty(fd, conn->props[i]);
            if (prop) {
                if (!strcmp(prop->name, "EDID")) {
                    conn->prop_values[i] = 1;
                }
                drmModeFreeProperty(prop);
            }
        }
    }
    modes[n++] = cea(1280, 720, 74250, 1390, 1430, 1650, 725, 730, 750, DRM_MODE_TYPE_USERDEF);
    free(conn->modes);
    conn->modes = modes;
    conn->count_modes = n;
    conn->connection = DRM_MODE_CONNECTED;
    return conn;
}

drmModeConnectorPtr drmModeGetConnector(int fd, uint32_t connectorId) {
    static drmModeConnectorPtr (*real)(int, uint32_t);
    if (!real) {
        real = dlsym(RTLD_NEXT, "drmModeGetConnector");
    }
    return fake(fd, real(fd, connectorId));
}

drmModeConnectorPtr drmModeGetConnectorCurrent(int fd, uint32_t connectorId) {
    static drmModeConnectorPtr (*real)(int, uint32_t);
    if (!real) {
        real = dlsym(RTLD_NEXT, "drmModeGetConnectorCurrent");
    }
    return fake(fd, real(fd, connectorId));
}
