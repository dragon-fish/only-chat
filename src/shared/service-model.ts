import type { ModelModalities } from './model-metadata'

/**
 * Whether a model can do the service model's job at all.
 *
 * Both directions are required and both are load-bearing. Output excludes the image and video
 * generators — asked for a conversation title, one of those returns a picture. Input excludes the
 * handful that only accept an image, which cannot be shown the message they are naming.
 *
 * A model that declares no modalities is refused rather than assumed: this list is a picker the
 * user chooses from, and offering an unknown quantity there costs more than omitting it.
 */
export function canServeAsServiceModel(metadata: { modalities?: ModelModalities }): boolean {
  const modalities = metadata.modalities
  if (!modalities) return false
  return modalities.input.includes('text') && modalities.output.includes('text')
}

/** File analysis needs a readable non-text modality and text output. */
export function canServeAsFileModel(metadata: { modalities?: ModelModalities }): boolean {
  return canServeAsServiceModel(metadata) && metadata.modalities!.input.some(mode => ['image', 'pdf', 'audio', 'video'].includes(mode))
}
