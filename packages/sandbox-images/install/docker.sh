#!/usr/bin/env bash
# Optional Docker variant: adds a pinned Docker Engine, CLI, containerd, Buildx
# and Compose on top of the default image. Runs only while constructing the
# Docker image candidate (install.sh docker), never at session boot.
set -euo pipefail
source "$OI_INSTALL_DIR/common.sh"
if [[ "$OI_OS" != debian ]]; then
  echo "The Docker variant currently requires Debian bookworm (got $OI_OS)" >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
package_dir="$(mktemp -d)"
trap 'rm -rf "$package_dir"' EXIT
for tool in ENGINE CLI CONTAINERD BUILDX COMPOSE; do
  file_key="DOCKER_${tool}_FILE"
  hash_key="DOCKER_${tool}_SHA256"
  download_checked \
    "https://download.docker.com/linux/debian/dists/bookworm/pool/stable/amd64/${!file_key}" \
    "${!hash_key}" \
    "$package_dir/${!file_key}"
done
apt-get update
apt-get install -y --no-install-recommends busybox-static "$package_dir"/*.deb
install -d -m 0755 /etc/docker
install -m 0644 "$OI_INSTALL_DIR/docker-daemon.json" /etc/docker/daemon.json
install -m 0644 "$OI_BUNDLE/packages/sandbox-images/verify/docker_smoke.py" /app/verify/docker_smoke.py
# A registry-independent BusyBox root filesystem lets image verification run
# a real build, container and Compose network without pulling anything.
rootfs="$(mktemp -d)"
mkdir -p "$rootfs/bin"
cp /bin/busybox "$rootfs/bin/busybox"
for applet in sh cat mkdir httpd wget sleep grep; do ln -s busybox "$rootfs/bin/$applet"; done
install -d -m 0755 /opt/openinspect/docker-smoke
tar --format=ustar --owner=0 --group=0 --numeric-owner -C "$rootfs" -cf /opt/openinspect/docker-smoke/rootfs.tar .
rm -rf "$rootfs"
docker --version
docker buildx version
docker compose version
