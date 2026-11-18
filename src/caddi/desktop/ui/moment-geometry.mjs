// Pure CSS-pixel geometry for an object-fit:contain evidence image. The image
// element may itself be wider than its decoded content when CSS caps height.
export function containedImageBounds({ stage, image, naturalWidth, naturalHeight, borderLeft = 0, borderTop = 0 }) {
  const values = [stage.left, stage.top, image.left, image.top, image.width, image.height,
    naturalWidth, naturalHeight, borderLeft, borderTop];
  if (values.some(value => !Number.isFinite(value)) || image.width <= 0 || image.height <= 0 ||
      naturalWidth <= 0 || naturalHeight <= 0 || borderLeft < 0 || borderTop < 0) return null;
  const scale = Math.min(image.width / naturalWidth, image.height / naturalHeight);
  const width = naturalWidth * scale, height = naturalHeight * scale;
  return Object.freeze({
    left: image.left - stage.left - borderLeft + (image.width - width) / 2,
    top: image.top - stage.top - borderTop + (image.height - height) / 2,
    width, height,
  });
}
