#!/usr/bin/env bash
# Optional Docker variant only. Never run this phase during Session startup.
set -euo pipefail

source "$OI_BUNDLE/image-config.sh"
if [[ "$OI_OS" != debian ]]; then
  echo 'The Docker variant currently requires Debian bookworm' >&2
  exit 1
fi
docker_package_dir="$(mktemp -d)"
trap 'rm -f "$docker_package_dir"/*.deb; rmdir "$docker_package_dir"' EXIT
for tool in ENGINE CLI CONTAINERD BUILDX COMPOSE; do
  file_key="DOCKER_${tool}_FILE"
  hash_key="DOCKER_${tool}_SHA256"
  package_file="${!file_key}"
  curl --fail --silent --show-error --location --retry 3 \
    "https://download.docker.com/linux/debian/dists/bookworm/pool/stable/amd64/$package_file" \
    --output "$docker_package_dir/$package_file"
  printf '%s  %s\n' "${!hash_key}" "$docker_package_dir/$package_file" | sha256sum --check --status
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  busybox-static "$docker_package_dir"/*.deb
install -d /opt/openinspect/docker /opt/openinspect/docker-smoke/rootfs/bin /app/verify
install -m 0644 "$OI_INSTALL_DIR/docker-daemon.json" /opt/openinspect/docker/daemon.json
install -m 0644 "$OI_BUNDLE/packages/sandbox-images/verify/docker_smoke.py" /app/verify/docker_smoke.py
# Bake a registry-independent image fixture. BusyBox is static, so the tarball
# can be imported directly by the native VM verification step.
install -m 0755 /bin/busybox /opt/openinspect/docker-smoke/rootfs/bin/busybox
for applet in sh cat mkdir httpd wget sleep grep; do
  ln -s busybox "/opt/openinspect/docker-smoke/rootfs/bin/$applet"
done
tar --format=ustar --owner=0 --group=0 --numeric-owner \
  -C /opt/openinspect/docker-smoke/rootfs -cf /opt/openinspect/docker-smoke/rootfs.tar .
rm -rf /opt/openinspect/docker-smoke/rootfs
docker --version
docker buildx version
docker compose version
