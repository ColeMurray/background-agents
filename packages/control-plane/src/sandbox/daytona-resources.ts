import type { SandboxSettings } from "@open-inspect/shared/types/integrations";

const DEFAULT_DAYTONA_CPU = 1;
const DEFAULT_DAYTONA_MEMORY_MIB = 2048;
const MIB_PER_GIB = 1024;

export interface DaytonaResources {
  cpu: number;
  memory: number;
}

/** Daytona accepts positive whole cores and GiB; round up to avoid under-provisioning. */
export function resolveDaytonaResources(settings?: SandboxSettings): DaytonaResources {
  const cpuCores = settings?.cpuCores ?? DEFAULT_DAYTONA_CPU;
  const memoryMib = settings?.memoryMib ?? DEFAULT_DAYTONA_MEMORY_MIB;
  if (!Number.isFinite(cpuCores) || cpuCores <= 0 || !Number.isSafeInteger(Math.ceil(cpuCores))) {
    throw new Error("Daytona CPU must resolve to a positive safe number of cores");
  }
  if (!Number.isFinite(memoryMib) || memoryMib <= 0 || !Number.isSafeInteger(memoryMib)) {
    throw new Error("Daytona memory must resolve to a positive safe MiB value");
  }
  const memory = Math.ceil(memoryMib / MIB_PER_GIB);
  if (!Number.isSafeInteger(memory)) {
    throw new Error("Daytona memory must resolve to a safe number of GiB");
  }
  return { cpu: Math.ceil(cpuCores), memory };
}

const DIGEST_IMAGE_RE = new RegExp(
  "^(?:localhost(?::[0-9]+)?|[a-z0-9]+(?:[.-][a-z0-9]+)+(?::[0-9]+)?)/" +
    "[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$"
);

export function requireDaytonaBaseImage(reference: string | undefined): string {
  if (!reference || reference !== reference.trim() || !DIGEST_IMAGE_RE.test(reference)) {
    throw new Error("DAYTONA_BASE_IMAGE must be a fully qualified sha256 digest reference");
  }
  return reference;
}

export function daytonaBuildConfigurationKey(
  baseImage: string,
  resources: DaytonaResources
): string {
  return `daytona-oci-v1:${baseImage}:cpu=${resources.cpu}:memory=${resources.memory}`;
}

export type DaytonaCreateSource =
  | { snapshot: string; buildInfo?: never; cpu?: never; memory?: never }
  | { snapshot?: never; buildInfo: { dockerfileContent: string }; cpu: number; memory: number };

export function daytonaCreateSource(
  source: { snapshot: string } | { image: string; resources: DaytonaResources }
): DaytonaCreateSource {
  if ("snapshot" in source) return { snapshot: source.snapshot };
  const image = requireDaytonaBaseImage(source.image);
  return {
    buildInfo: { dockerfileContent: `FROM ${image}` },
    cpu: source.resources.cpu,
    memory: source.resources.memory,
  };
}
