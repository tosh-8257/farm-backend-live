import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { MulterError } from 'multer';
import type { Response } from 'express';

@Catch(MulterError)
export class UploadExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const message =
      exception.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Cover and gallery images must be 5 MB or smaller. Documents must be 10 MB or smaller.'
        : exception.code === 'LIMIT_FILE_COUNT' ||
            exception.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Send at most 5 images. Use the field image, images, cover, photo, or file.'
          : 'The upload could not be read. Send a JPG, PNG, WebP, or HEIC image as multipart form data.';
    res.status(400).json({
      statusCode: 400,
      message,
      error: 'Bad Request',
    });
  }
}

const IMAGE_FIELDS = new Set([
  'image',
  'images',
  'file',
  'files',
  'cover',
  'photo',
  'gallery',
]);

export function pickUploadedImages<T extends { fieldname: string }>(
  files: T[] | undefined,
): T[] {
  return (files ?? []).filter((file) => IMAGE_FIELDS.has(file.fieldname));
}

/** jpg, png, webp, or heic/heif. Null when the bytes do not match. */
export function detectImageKind(
  buffer: Buffer,
): 'jpeg' | 'png' | 'webp' | 'heic' | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1').toLowerCase();
    if (['heic', 'heix', 'heif', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}
