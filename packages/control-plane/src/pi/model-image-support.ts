import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { toPiModel } from "./runtime-contract";

/** The part of a model record that says whether it takes images. */
interface ImageCapableModel {
  input?: readonly string[];
}

/**
 * Whether a model takes images as input.
 *
 * A model that does not would have the image dropped from its prompt, so a
 * turn that carries an image is refused for it rather than run without one.
 */
export function modelAcceptsImages(model: ImageCapableModel | undefined): boolean {
  return model !== undefined && (model.input?.includes("image") ?? false);
}

/**
 * Whether the Pi model a session runs can take an image as input.
 *
 * The catalog is the same one the Pi Durable Object opens its provider with
 * (`openaiCodexProvider()`), so this answers for the model the turn will
 * really use. A model that is not in the catalog, or a model that takes text
 * only, answers false.
 */
export function piModelAcceptsImages(modelId: string): boolean {
  let reference: { provider: "openai-codex"; id: string };
  try {
    reference = toPiModel(modelId);
  } catch {
    return false;
  }
  const catalog = OPENAI_CODEX_MODELS as unknown as Record<string, ImageCapableModel | undefined>;
  return modelAcceptsImages(catalog[reference.id]);
}
