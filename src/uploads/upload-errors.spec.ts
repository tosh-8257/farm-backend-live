import { detectImageKind, pickUploadedImages } from './upload-errors';

describe('upload image checks', () => {
  it('recognises jpeg, png, webp, and heic bytes', () => {
    expect(
      detectImageKind(
        Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe('jpeg');
    const png = Buffer.alloc(12);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageKind(png)).toBe('png');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    expect(detectImageKind(webp)).toBe('webp');
    const heic = Buffer.alloc(12);
    heic.write('ftyp', 4);
    heic.write('heic', 8);
    expect(detectImageKind(heic)).toBe('heic');
    expect(detectImageKind(Buffer.from('not an image!!'))).toBeNull();
  });

  it('accepts the field names the app uses for cover and gallery', () => {
    const files = [
      { fieldname: 'cover' },
      { fieldname: 'notes' },
      { fieldname: 'gallery' },
    ];
    expect(pickUploadedImages(files).map((file) => file.fieldname)).toEqual([
      'cover',
      'gallery',
    ]);
  });
});
