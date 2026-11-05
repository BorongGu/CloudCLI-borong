/** The guest attachment queue reduces mobile uploads while preserving legible screenshot text. */
export async function prepareGuestImage(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 20_000_000) throw new Error('请选择小于 20 MB 的图片。');
  if (file.size <= 180_000) return file;
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();image.src = url;await image.decode();
    const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');if (!context) throw new Error('图片处理失败，请重新选择。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', .88));
    canvas.width = 0;canvas.height = 0;
    const result = compressed && compressed.size < file.size ? compressed : file;
    if (result.size > 5_000_000) throw new Error('图片较大，请裁剪题目区域后上传。');
    return result;
  } finally { URL.revokeObjectURL(url); }
}
