export interface CropRect { x: number; y: number; width: number; height: number }
export type CropHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export function initialCrop(width: number, height: number, aspectRatio?: number): CropRect {
  if (!aspectRatio) return { x: width * 0.1, y: height * 0.1, width: width * 0.8, height: height * 0.8 }
  const cropWidth = Math.min(width, height * aspectRatio)
  const cropHeight = cropWidth / aspectRatio
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight }
}

export function moveCrop(crop: CropRect, dx: number, dy: number, width: number, height: number): CropRect {
  return {
    ...crop,
    x: Math.max(0, Math.min(crop.x + dx, width - crop.width)),
    y: Math.max(0, Math.min(crop.y + dy, height - crop.height)),
  }
}

export function resizeCrop(
  crop: CropRect, handle: Exclude<CropHandle, 'move'>, dx: number, dy: number,
  imageWidth: number, imageHeight: number, aspectRatio?: number, minSize = 32,
): CropRect {
  const left = handle.includes('w')
  const right = handle.includes('e')
  const top = handle.includes('n')
  const bottom = handle.includes('s')
  let x = crop.x + (left ? dx : 0)
  let y = crop.y + (top ? dy : 0)
  let width = crop.width + (right ? dx : left ? -dx : 0)
  let height = crop.height + (bottom ? dy : top ? -dy : 0)

  if (aspectRatio) {
    if ((left || right) && (top || bottom)) {
      const candidateWidth = Math.abs(dx) >= Math.abs(dy) ? width : height * aspectRatio
      width = candidateWidth
      height = width / aspectRatio
      if (left) x = crop.x + crop.width - width
      if (top) y = crop.y + crop.height - height
    } else if (left || right) {
      height = width / aspectRatio
      y = crop.y + (crop.height - height) / 2
    } else {
      width = height * aspectRatio
      x = crop.x + (crop.width - width) / 2
    }
  }

  const minWidth = aspectRatio ? Math.max(minSize, minSize * aspectRatio) : minSize
  const minHeight = aspectRatio ? minWidth / aspectRatio : minSize
  width = Math.max(minWidth, width)
  height = Math.max(minHeight, height)
  if (left) x = crop.x + crop.width - width
  if (top) y = crop.y + crop.height - height

  const maxWidth = Math.min(imageWidth - x, aspectRatio ? (imageHeight - y) * aspectRatio : Infinity)
  const maxHeight = Math.min(imageHeight - y, aspectRatio ? maxWidth / aspectRatio : Infinity)
  width = Math.min(width, maxWidth)
  height = Math.min(height, maxHeight)
  x = Math.max(0, Math.min(x, imageWidth - width))
  y = Math.max(0, Math.min(y, imageHeight - height))
  return { x, y, width, height }
}
