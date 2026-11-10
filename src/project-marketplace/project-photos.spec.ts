import { BadRequestException } from '@nestjs/common';
import { cleanProjectInput } from './business-projects.service';

describe('project cover and gallery', () => {
  it('keeps https cover and gallery urls', () => {
    expect(
      cleanProjectInput({
        banner_image: 'https://res.cloudinary.com/demo/cover.jpg',
        gallery_images: ['https://res.cloudinary.com/demo/a.jpg'],
      }),
    ).toEqual({
      banner_image: 'https://res.cloudinary.com/demo/cover.jpg',
      gallery_images: ['https://res.cloudinary.com/demo/a.jpg'],
    });
  });

  it('rejects a cover that was not uploaded', () => {
    expect(() =>
      cleanProjectInput({ banner_image: 'file:///cover.jpg' }),
    ).toThrow(BadRequestException);
  });
});
