import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Express } from 'express';
import type { UploadApiResponse } from 'cloudinary';
import {
  cloudinary,
  cloudinaryErrorMessage,
  configureCloudinary,
} from './cloudinary';

type UploadedImage = { url: string; public_id: string };

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  async uploadSingle(
    file: Express.Multer.File,
    format?: 'jpg',
  ): Promise<UploadedImage> {
    return this.uploadToCloudinary(file, 'image', 'farmapp', format);
  }

  /** Business documents: PDFs are stored as raw files, images as images. */
  async uploadDocument(
    file: Express.Multer.File,
    kind: 'pdf' | 'image',
  ): Promise<UploadedImage> {
    return this.uploadToCloudinary(
      file,
      kind === 'pdf' ? 'raw' : 'image',
      'farmapp/business-documents',
    );
  }

  private async uploadToCloudinary(
    file: Express.Multer.File,
    resourceType: 'image' | 'raw',
    folder: string,
    format?: 'jpg',
  ): Promise<UploadedImage> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Uploaded image is empty');
    }
    try {
      configureCloudinary();
      const result = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: resourceType,
            ...(format ? { format } : {}),
          },
          (error, response) => {
            if (error)
              return reject(new Error(error.message || 'Upload failed'));
            if (!response)
              return reject(new Error('Cloudinary returned no result'));
            resolve(response);
          },
        );
        stream.on('error', reject);
        stream.end(file.buffer);
      });
      if (!result.secure_url || !result.public_id) {
        throw new Error('Cloudinary returned incomplete image details');
      }
      return { url: result.secure_url, public_id: result.public_id };
    } catch (error) {
      const detail = cloudinaryErrorMessage(error);
      this.logger.error(
        `Cloudinary image upload failed: ${detail}`,
        error instanceof Error ? error.stack : String(error),
      );
      if (detail.startsWith('Missing Cloudinary configuration')) {
        throw new ServiceUnavailableException(detail);
      }
      throw new ServiceUnavailableException(
        `Could not store the file. ${detail}`.slice(0, 300),
      );
    }
  }

  async uploadMultiple(files: Express.Multer.File[]): Promise<UploadedImage[]> {
    if (files.length < 1 || files.length > 5) {
      throw new BadRequestException('Upload between 1 and 5 images');
    }
    const uploaded: UploadedImage[] = [];
    for (const file of files) {
      uploaded.push(await this.uploadSingle(file));
    }
    return uploaded;
  }
}
