# Build-and-run environment for the scenario suite: everything needed to
# compile fppd from source and run it headless, and nothing else (no Apache,
# PHP-FPM, Samba or the rest of a full FPP image).
FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++ make pkg-config ccache mold git curl ca-certificates \
        php-cli \
        libdrogon-dev libjsoncpp-dev libcurl4-openssl-dev libzstd-dev zlib1g-dev \
        libmosquitto-dev libssl-dev libtag1-dev libgpiod-dev libsystemd-dev \
        libavahi-client-dev libdrm-dev libnl-3-dev libnl-genl-3-dev \
        libgraphicsmagick++1-dev graphicsmagick-libmagick-dev-compat \
        libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libsamplerate0-dev \
        libusb-1.0-0-dev libasound2-dev libpipewire-0.3-dev libsdl2-dev mesa-common-dev \
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
        python3 python3-pytest python3-zstandard procps iproute2 gdb patch \
    && rm -rf /var/lib/apt/lists/*

# FPP's makefiles skip the OLED/cape/RTC tools when this marker exists, and
# fppd takes its PLATFORM_DOCKER paths.
RUN mkdir -p /etc/fpp && touch /etc/fpp/container
