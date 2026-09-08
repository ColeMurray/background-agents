#!/usr/bin/env bash
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
source /etc/os-release
[[ "$ID" == amzn && "$VERSION_ID" == 2023 ]] || { echo 'Expected Amazon Linux 2023' >&2; exit 1; }
dnf install -y dnf-plugins-core git gcc gcc-c++ make ca-certificates openssh-clients jq unzip tar gzip \
  util-linux shadow-utils procps-ng xorg-x11-server-Xvfb autoconf automake libtool cmake xz diffutils \
  pkgconf-pkg-config openssl-devel libjpeg-turbo-devel zlib-devel libX11-devel libXext-devel libXft-devel \
  libXinerama-devel libXpm-devel libXrandr-devel libXtst-devel libXfixes-devel libXdamage-devel \
  libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon libdrm mesa-libgbm \
  alsa-lib atk at-spi2-atk cups-libs pango cairo nspr nss
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
dnf install -y gh
# Video encoding is optional on the legacy Vercel substrate; recorded by verification.
dnf install -y ffmpeg || echo 'openinspect.image.optional_unavailable=ffmpeg'
build_dir="$(mktemp -d /tmp/openinspect-desktop.XXXXXX)"
trap 'rm -rf "$build_dir"' EXIT
download_checked "https://sourceforge.net/projects/fluxbox/files/fluxbox/$FLUXBOX_VERSION/fluxbox-$FLUXBOX_VERSION.tar.xz/download" "$FLUXBOX_SHA256" "$build_dir/fluxbox.tar.xz"
tar -xJf "$build_dir/fluxbox.tar.xz" -C "$build_dir"
(cd "$build_dir/fluxbox-$FLUXBOX_VERSION" && sed -i 's/text_prop.value > 0/text_prop.value != 0/' util/fluxbox-remote.cc && ./configure --disable-imlib2 && make -j2 && make install)
download_checked "https://github.com/LibVNC/libvncserver/archive/refs/tags/LibVNCServer-$LIBVNCSERVER_VERSION.tar.gz" "$LIBVNCSERVER_SHA256" "$build_dir/libvncserver.tar.gz"
tar -xzf "$build_dir/libvncserver.tar.gz" -C "$build_dir"
# Use the system library directory: Amazon Linux does not load /usr/local/lib64 by default.
cmake -S "$build_dir/libvncserver-LibVNCServer-$LIBVNCSERVER_VERSION" -B "$build_dir/libvncserver-build" -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib64 -DWITH_GCRYPT=OFF -DWITH_GNUTLS=OFF -DWITH_FFMPEG=OFF -DWITH_PNG=OFF -DWITH_SDL=OFF -DWITH_SYSTEMD=OFF
cmake --build "$build_dir/libvncserver-build" --parallel 2
cmake --install "$build_dir/libvncserver-build"
ldconfig
download_checked "https://github.com/LibVNC/x11vnc/archive/refs/tags/$X11VNC_VERSION.tar.gz" "$X11VNC_SHA256" "$build_dir/x11vnc.tar.gz"
tar -xzf "$build_dir/x11vnc.tar.gz" -C "$build_dir"
(cd "$build_dir/x11vnc-$X11VNC_VERSION" && CFLAGS=-fcommon PKG_CONFIG_PATH=/usr/local/lib64/pkgconfig:/usr/local/lib/pkgconfig ./autogen.sh && make -j2 && make install)
x11vnc -version
mkdir -p /usr/share/novnc
download_checked "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz" "$NOVNC_SHA256" "$build_dir/novnc.tar.gz"
tar -xzf "$build_dir/novnc.tar.gz" -C /usr/share/novnc --strip-components=1
