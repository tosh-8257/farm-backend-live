import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { memoryStorage } from 'multer';
import { JwtGuard } from '../common/guards/jwt.guard';
import { UploadsService } from './uploads.service';
import {
  detectImageKind,
  pickUploadedImages,
  UploadExceptionFilter,
} from './upload-errors';

const imageUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (
    _request: unknown,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif',
      'image/heic-sequence',
      'application/octet-stream',
    ]);
    const allowedExtensions = /\.(jpe?g|png|webp|heic|heif)$/i;
    if (
      !allowedMimeTypes.has(file.mimetype) ||
      !allowedExtensions.test(file.originalname)
    ) {
      return callback(
        new BadRequestException(
          'Only JPG, PNG, WebP, and HEIC images are supported',
        ),
        false,
      );
    }
    callback(null, true);
  },
};

const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

const documentUploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_BYTES },
  fileFilter: (
    _request: unknown,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const allowedMimeTypes = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    if (
      !allowedMimeTypes.has(file.mimetype) ||
      !/\.(pdf|jpe?g|png|webp)$/i.test(file.originalname)
    ) {
      return callback(
        new BadRequestException(
          'Only PDF, JPG, PNG and WebP files are supported',
        ),
        false,
      );
    }
    callback(null, true);
  },
};

/** Checks the file's magic bytes so a renamed file cannot pass as a PDF/image. */
export function detectDocumentKind(buffer: Buffer): 'pdf' | 'image' | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'image';
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image';
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image';
  return null;
}

@UseGuards(JwtGuard)
@UseFilters(UploadExceptionFilter)
@Controller({ path: 'uploads', version: '1' })
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('single')
  @UseInterceptors(AnyFilesInterceptor(imageUploadOptions))
  async uploadSingle(@UploadedFiles() files?: Express.Multer.File[]) {
    const file = pickUploadedImages(files)[0];
    if (!file) {
      throw new BadRequestException(
        'An image file is required. Send it as image, cover, photo, or file.',
      );
    }
    const kind = this.requireImage(file);
    const uploaded = await this.uploadsService.uploadSingle(
      file,
      kind === 'heic' ? 'jpg' : undefined,
    );
    return { url: uploaded.url };
  }

  @Post('multiple')
  @UseInterceptors(
    AnyFilesInterceptor({
      ...imageUploadOptions,
      limits: { ...imageUploadOptions.limits, files: 5 },
    }),
  )
  async uploadMultiple(@UploadedFiles() files?: Express.Multer.File[]) {
    const images = pickUploadedImages(files);
    if (!images.length) {
      throw new BadRequestException(
        'At least one image is required. Send them as images, gallery, or file.',
      );
    }
    if (images.length > 5) {
      throw new BadRequestException('Upload between 1 and 5 images');
    }
    const uploaded: { url: string }[] = [];
    for (const file of images) {
      const kind = this.requireImage(file);
      uploaded.push(
        await this.uploadsService.uploadSingle(
          file,
          kind === 'heic' ? 'jpg' : undefined,
        ),
      );
    }
    return { urls: uploaded.map((image) => image.url) };
  }

  private requireImage(file: Express.Multer.File) {
    const kind = detectImageKind(file.buffer);
    if (!kind) {
      throw new BadRequestException(
        'File content is not a JPG, PNG, WebP, or HEIC image',
      );
    }
    return kind;
  }

  @Post('document')
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  async uploadDocument(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('A file is required');
    const kind = detectDocumentKind(file.buffer);
    const declaredPdf = file.mimetype === 'application/pdf';
    if (!kind || (kind === 'pdf') !== declaredPdf) {
      throw new BadRequestException('File content does not match its type');
    }
    const uploaded = await this.uploadsService.uploadDocument(file, kind);
    return { url: uploaded.url, file_name: file.originalname, kind };
  }
}
