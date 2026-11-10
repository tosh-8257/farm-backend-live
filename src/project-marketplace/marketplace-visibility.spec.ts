import {
  marketplaceListWhere,
  projectIsPublic,
} from './marketplace-visibility';

describe('marketplace visibility', () => {
  it('hides business projects until they are listed', () => {
    expect(projectIsPublic({ business_id: 'b1', status: 'submitted' })).toBe(
      false,
    );
    expect(projectIsPublic({ business_id: 'b1', status: 'approved' })).toBe(
      false,
    );
    expect(projectIsPublic({ business_id: 'b1', status: 'listed' })).toBe(true);
    expect(projectIsPublic({ business_id: null, status: 'open' })).toBe(true);
  });

  it('browse query never selects an unlisted business project', () => {
    expect(marketplaceListWhere(undefined)).toEqual({
      OR: [
        { business_id: null, status: { in: ['listed', 'open'] } },
        { business_id: { not: null }, status: 'listed' },
      ],
    });
    expect(marketplaceListWhere('all')).toEqual({
      OR: [
        {
          business_id: null,
          status: { in: ['listed', 'open', 'funded', 'closed'] },
        },
        {
          business_id: { not: null },
          status: { in: ['listed', 'funded', 'closed'] },
        },
      ],
    });
  });
});
