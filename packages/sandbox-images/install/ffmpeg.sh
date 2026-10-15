#!/usr/bin/env bash
# Build OpenComputer's recording path from pinned, architecture-neutral sources.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
build_dir="$(mktemp -d /tmp/openinspect-video.XXXXXX)"
trap 'rm -rf "$build_dir"' EXIT
prefix=/opt/openinspect/video
download_checked "https://code.videolan.org/videolan/x264/-/archive/$X264_REVISION/x264-$X264_REVISION.tar.gz" "$X264_SHA256" "$build_dir/x264.tar.gz"
tar -xzf "$build_dir/x264.tar.gz" -C "$build_dir"
(cd "$build_dir/x264-$X264_REVISION" && ./configure --prefix="$prefix" --enable-static --disable-cli --enable-pic --disable-opencl && make -j2 && make install)
download_checked "https://github.com/webmproject/libvpx/archive/refs/tags/v$LIBVPX_VERSION.tar.gz" "$LIBVPX_SHA256" "$build_dir/libvpx.tar.gz"
tar -xzf "$build_dir/libvpx.tar.gz" -C "$build_dir"
(cd "$build_dir/libvpx-$LIBVPX_VERSION" && ./configure --prefix="$prefix" --libdir="$prefix/lib" \
  --enable-pic --disable-shared --disable-tools --disable-examples --disable-unit-tests --disable-docs --disable-vp9 \
  && make -j2 && make install)
download_checked "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" "$build_dir/ffmpeg.tar.xz"
tar -xJf "$build_dir/ffmpeg.tar.xz" -C "$build_dir"
(cd "$build_dir/ffmpeg-$FFMPEG_VERSION" && PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure \
  --prefix="$prefix" --enable-gpl --enable-libx264 --enable-libvpx --enable-zlib --pkg-config-flags=--static \
  --disable-autodetect --disable-debug --disable-doc --disable-ffplay --disable-x86asm \
  --disable-everything --enable-ffmpeg --enable-encoder=libx264,libvpx_vp8,png,mjpeg,rawvideo \
  --enable-decoder=png,mjpeg,rawvideo,h264,wrapped_avframe --enable-demuxer=image2,image2pipe,rawvideo,mov \
  --enable-parser=mjpeg,png,h264 \
  --enable-muxer=mp4,webm,image2,null --enable-protocol=file,pipe \
  --enable-filter=scale,format,fps,color,testsrc,pad --enable-indev=lavfi \
  && make -j2 && make install)
ln -sf "$prefix/bin/ffmpeg" /usr/local/bin/ffmpeg
