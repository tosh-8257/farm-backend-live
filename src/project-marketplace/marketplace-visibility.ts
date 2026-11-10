import { INVESTABLE, MARKET_VISIBLE } from './project-rules';

/** Business projects are public only after an admin lists them. */
export const BUSINESS_PUBLIC = ['listed', 'funded', 'closed'];

/**
 * Marketplace browse filter.
 * Legacy rows (no business) may still be `open`. A business project in
 * draft, submitted, approved, or rejected is never returned.
 */
export function marketplaceListWhere(status?: string) {
  if (status === 'funded') return { status: { in: ['funded'] } };
  if (status === 'all') {
    return {
      OR: [
        { business_id: null, status: { in: MARKET_VISIBLE } },
        { business_id: { not: null }, status: { in: BUSINESS_PUBLIC } },
      ],
    };
  }
  return {
    OR: [
      { business_id: null, status: { in: INVESTABLE } },
      { business_id: { not: null }, status: 'listed' },
    ],
  };
}

export function projectIsPublic(project: {
  business_id?: string | null;
  status?: string | null;
}) {
  if (project.business_id)
    return BUSINESS_PUBLIC.includes(project.status ?? '');
  return MARKET_VISIBLE.includes(project.status ?? '');
}
