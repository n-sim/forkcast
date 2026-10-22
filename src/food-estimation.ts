import { execute } from './core';
import type { Nutrition } from './food-log';

// An estimation photo only ever lives in this page's memory and travels with
// one estimate request. It is never saved: unlike a recipe cover photo, it
// has no store, no record, and no synchronization.

export interface FoodEstimate {
  description: string;
  nutrition: Nutrition;
}

const accepted = ['image/jpeg', 'image/png', 'image/webp'];
/** Photos are reduced to this longest side before they are sent. */
const maxSide = 1600;

/**
 * Reads a chosen photo and reduces it to a JPEG small enough to send.
 * Throws a message for the person when it is not a usable image.
 */
export async function prepareEstimationPhoto(file: File): Promise<Blob> {
  if (!accepted.includes(file.type))
    throw new Error('Choose a JPEG, PNG, or WebP photo.');
  if (file.size > 25 * 1024 * 1024)
    throw new Error('Choose a photo smaller than 25 MB.');
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error(
      'This photo could not be read. Choose a valid JPEG, PNG, or WebP image.',
    );
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas
      .getContext('2d')!
      .drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob) throw new Error('Not encoded.');
    return blob;
  } catch {
    throw new Error(
      'This photo could not be prepared. Choose another JPEG, PNG, or WebP image.',
    );
  } finally {
    image.close();
  }
}

async function base64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

/**
 * Asks the core for an AI estimate of food from a description, a photo, or
 * both. The result is a suggestion for a manual entry; nothing is logged.
 */
export async function estimateFood(
  model: string,
  description: string,
  photo: Blob | null,
): Promise<FoodEstimate> {
  return execute<FoodEstimate>(
    'estimateFood',
    {
      model,
      ...(description.trim() ? { description } : {}),
      ...(photo
        ? { image: { mime: photo.type, data: await base64(photo) } }
        : {}),
    },
    // An estimate can legitimately take minutes.
    200_000,
  );
}
