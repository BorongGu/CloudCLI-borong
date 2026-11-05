import { optimizeChatImage } from '@/shared/utils';

/** The guest attachment queue reduces mobile uploads while preserving legible screenshot text. */
export async function prepareGuestImage(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 20_000_000) throw new Error('请选择小于 20 MB 的图片。');
  const result = await optimizeChatImage(file);
  if (result.size > 5_000_000) throw new Error('图片较大，请裁剪题目区域后上传。');
  return result;
}
