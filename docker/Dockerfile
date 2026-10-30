# Build-and-run environment for the scenario suite: everything needed to
# compile fppd from source and run it headless, and nothing else (no Apache,
# PHP-FPM, Samba or the rest of a full FPP image).
FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive
# fonts-dejavu-core: the Text overlay effect draws nothing without a font,
# and every scenario that renders text skips.
# libav*-dev: fpp before e8279e3cc built its SDL video output on ffmpeg,
# so trees from before then don't build without it. Nothing later uses it.
# avahi-daemon, avahi-utils: test_mdns.py starts a daemon of its own (on a
# system bus of its own) for fppd's mDNS backend, and reads what it publishes
# with avahi-browse. Nothing starts them otherwise, so fppd elsewhere still
# runs without a daemon, as it always has here.
# xxd, device-tree-compiler, jq: what FPP's own scripts call (the PocketBeagle2
# EEPROM repair, the Pi overlay upgrade steps, the health check's warnings
# item); without them the scenarios for those fall back to stand-ins.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++ make pkg-config ccache mold git curl ca-certificates \
        php-cli php-xml \
        libdrogon-dev libjsoncpp-dev libcurl4-openssl-dev libzstd-dev zlib1g-dev \
        libmosquitto-dev libssl-dev libtag1-dev libgpiod-dev libsystemd-dev \
        libavahi-client-dev libdrm-dev libnl-3-dev libnl-genl-3-dev \
        libgraphicsmagick++1-dev graphicsmagick-libmagick-dev-compat \
        libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libsamplerate0-dev \
        libgstrtspserver-1.0-dev \
        libusb-1.0-0-dev libasound2-dev libpipewire-0.3-dev libsdl2-dev mesa-common-dev \
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pipewire gstreamer1.0-tools \
        gstreamer1.0-plugins-bad gstreamer1.0-alsa \
        edid-decode \
        pipewire pipewire-bin pipewire-pulse wireplumber pulseaudio-utils \
        python3 python3-pytest python3-zstandard faketime tzdata procps iproute2 gdb patch zip rsync \
        mosquitto mosquitto-clients gcovr qrencode \
        xxd device-tree-compiler jq avahi-daemon avahi-utils \
        fonts-dejavu-core \
        libavformat-dev libavcodec-dev libavutil-dev libswresample-dev libswscale-dev \
    && rm -rf /var/lib/apt/lists/*

# fppd before 2b27ed08a lists only the fonts at the top of the font
# directories, not in their subdirectories, where Debian puts every one; a
# copy of one face at the top lets the Text scenarios run against those trees.
RUN cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/

# FPP's makefiles skip the OLED/cape/RTC tools when this marker exists, and
# fppd takes its PLATFORM_DOCKER paths.
RUN mkdir -p /etc/fpp && touch /etc/fpp/container
