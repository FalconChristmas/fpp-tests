/* edidsink.so: LD_PRELOAD into fppd to make a connector forced "on" through
 * its sysfs status look like one with a display on it.
 *
 * A forced connector reads "connected" with the kernel's fallback modes but
 * no EDID, and fppd counts an HDMI connector without an EDID as empty. For
 * the connector EDIDSINK_CONNECTOR_ID, drmModeGetConnector() and
 * drmModeGetConnectorCurrent() give its EDID property a value whenever the
 * kernel says it is connected, so forcing it "on" and "off" stands in for a
 * display being plugged in and unplugged; the modes and the status are the
 * kernel's own.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <xf86drmMode.h>

static drmModeConnectorPtr fake(int fd, drmModeConnectorPtr conn) {
    const char* id = getenv("EDIDSINK_CONNECTOR_ID");
    if (!conn || !id || conn->connector_id != (uint32_t)atoi(id) || conn->connection != DRM_MODE_CONNECTED) {
        return conn;
    }
    for (int i = 0; i < conn->count_props; i++) {
        drmModePropertyPtr prop = drmModeGetProperty(fd, conn->props[i]);
        if (prop) {
            if (!strcmp(prop->name, "EDID") && !conn->prop_values[i]) {
                conn->prop_values[i] = 1;
            }
            drmModeFreeProperty(prop);
        }
    }
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
