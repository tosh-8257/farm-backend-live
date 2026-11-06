import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { BusinessService } from './business.service';

function completeBusiness(overrides: any = {}) {
  return {
    id: 'biz-1',
    owner_user_id: 'user-1',
    status: 'draft',
    legal_name: 'Acme Ltd',
    registration_number: 'PVT-123',
    registration_country: 'KE',
    sector: 'agriculture',
    country: 'Kenya',
    address: '1 Road',
    business_email: 'a@acme.co',
    business_phone: '+254700000000',
    persons: [
      { role: 'director', full_name: 'Jane' },
      { role: 'beneficial_owner', full_name: 'John', ownership_percent: 60 },
    ],
    documents: [
      { doc_type: 'certificate_of_incorporation', file_url: 'https://x/a.png' },
      { doc_type: 'proof_of_address', file_url: 'https://x/b.png' },
    ],
    verifications: [],
    ...overrides,
  };
}

describe('BusinessService', () => {
  let prisma: any;
  let svc: BusinessService;

  beforeEach(() => {
    prisma = {
      businesses: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      merchants: { findFirst: jest.fn() },
      business_persons: { deleteMany: jest.fn(), createMany: jest.fn() },
      business_documents: { deleteMany: jest.fn(), createMany: jest.fn() },
      business_verifications: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      notifications: { create: jest.fn() },
      audit_logs: { create: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    svc = new BusinessService(prisma);
  });

  describe('upgradeFromMerchant', () => {
    it('requires a merchant record', async () => {
      prisma.businesses.findUnique.mockResolvedValue(null);
      prisma.merchants.findFirst.mockResolvedValue(null);
      await expect(svc.upgradeFromMerchant('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('requires an approved merchant', async () => {
      prisma.businesses.findUnique.mockResolvedValue(null);
      prisma.merchants.findFirst.mockResolvedValue({
        id: 'm1',
        status: 'pending',
      });
      await expect(svc.upgradeFromMerchant('user-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('creates a Draft prefilled from the merchant, never approved', async () => {
      prisma.businesses.findUnique.mockResolvedValue(null);
      prisma.merchants.findFirst.mockResolvedValue({
        id: 'm1',
        status: 'approved',
        business_name: 'Acme',
        business_email: 'a@acme.co',
        country: 'Kenya',
      });
      prisma.businesses.create.mockImplementation(({ data }: any) => ({
        ...data,
        persons: [],
        documents: [],
      }));
      const res = await svc.upgradeFromMerchant('user-1');
      const data = prisma.businesses.create.mock.calls[0][0].data;
      expect(data.status).toBe('draft');
      expect(data.merchant_id).toBe('m1');
      expect(data.legal_name).toBe('Acme');
      expect(res.data.status).toBe('draft');
    });

    it('is idempotent when a business already exists', async () => {
      prisma.businesses.findUnique.mockResolvedValue(
        completeBusiness({ status: 'under_review' }),
      );
      const res = await svc.upgradeFromMerchant('user-1');
      expect(prisma.businesses.create).not.toHaveBeenCalled();
      expect(res.data.status).toBe('under_review');
    });
  });

  describe('saveDraft', () => {
    it('blocks edits while under review', async () => {
      prisma.businesses.findUnique.mockResolvedValue({
        id: 'biz-1',
        status: 'under_review',
      });
      await expect(
        svc.saveDraft('user-1', { legal_name: 'X' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('blocks edits once approved', async () => {
      prisma.businesses.findUnique.mockResolvedValue({
        id: 'biz-1',
        status: 'approved',
      });
      await expect(
        svc.saveDraft('user-1', { legal_name: 'X' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaces persons and documents and moves rejected back to draft', async () => {
      prisma.businesses.findUnique.mockResolvedValue({
        id: 'biz-1',
        status: 'rejected',
      });
      prisma.businesses.update.mockResolvedValue(completeBusiness());
      await svc.saveDraft('user-1', {
        legal_name: 'Acme',
        persons: [{ role: 'director', full_name: 'Jane' }],
        documents: [
          { doc_type: 'proof_of_address', file_url: 'https://x/b.png' },
        ],
      });
      expect(prisma.business_persons.deleteMany).toHaveBeenCalledWith({
        where: { business_id: 'biz-1' },
      });
      expect(prisma.business_persons.createMany).toHaveBeenCalled();
      expect(prisma.business_documents.createMany).toHaveBeenCalled();
      expect(prisma.businesses.update.mock.calls[0][0].data.status).toBe(
        'draft',
      );
    });
  });

  describe('submit', () => {
    const prev = process.env.MANUAL_KYB_ENABLED;
    beforeEach(() => {
      process.env.MANUAL_KYB_ENABLED = 'true';
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.MANUAL_KYB_ENABLED;
      else process.env.MANUAL_KYB_ENABLED = prev;
    });

    it('refuses manual submit when Didit is the only KYB path', async () => {
      delete process.env.MANUAL_KYB_ENABLED;
      await expect(svc.submit('user-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lists missing requirements', async () => {
      prisma.businesses.findUnique.mockResolvedValue(
        completeBusiness({ legal_name: '', documents: [], persons: [] }),
      );
      await expect(svc.submit('user-1')).rejects.toMatchObject({
        response: expect.objectContaining({
          missing: expect.arrayContaining([
            'legal_name',
            'directors',
            'beneficial_owners',
            'document:proof_of_address',
          ]),
        }),
      });
    });

    it('moves a complete draft to Under Review and records a verification', async () => {
      prisma.businesses.findUnique.mockResolvedValue(completeBusiness());
      prisma.businesses.updateMany.mockResolvedValue({ count: 1 });
      prisma.businesses.findUniqueOrThrow.mockResolvedValue(
        completeBusiness({ status: 'under_review' }),
      );
      const res = await svc.submit('user-1');
      expect(prisma.businesses.updateMany.mock.calls[0][0].data.status).toBe(
        'under_review',
      );
      expect(prisma.business_verifications.create).toHaveBeenCalled();
      expect(res.data.status).toBe('under_review');
    });

    it('rejects a second submission', async () => {
      prisma.businesses.findUnique.mockResolvedValue(
        completeBusiness({ status: 'under_review' }),
      );
      await expect(svc.submit('user-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('guards against concurrent double submit', async () => {
      prisma.businesses.findUnique.mockResolvedValue(completeBusiness());
      prisma.businesses.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.submit('user-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.business_verifications.create).not.toHaveBeenCalled();
    });
  });

  describe('adminReview', () => {
    const prev = process.env.MANUAL_KYB_ENABLED;
    beforeEach(() => {
      process.env.MANUAL_KYB_ENABLED = 'true';
      prisma.businesses.findUnique.mockResolvedValue({
        id: 'biz-1',
        owner_user_id: 'user-1',
        status: 'under_review',
      });
      prisma.businesses.updateMany.mockResolvedValue({ count: 1 });
      prisma.business_verifications.findFirst.mockResolvedValue({ id: 'v1' });
      prisma.businesses.findUniqueOrThrow.mockResolvedValue({
        id: 'biz-1',
        status: 'approved',
      });
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.MANUAL_KYB_ENABLED;
      else process.env.MANUAL_KYB_ENABLED = prev;
    });

    it('approves only on an explicit admin decision', async () => {
      await svc.adminReview('admin-1', 'biz-1', { decision: 'approve' });
      const data = prisma.businesses.updateMany.mock.calls[0][0].data;
      expect(data.status).toBe('approved');
      expect(data.reviewed_by).toBe('admin-1');
      expect(prisma.notifications.create).toHaveBeenCalled();
    });

    it('requires notes for reject or request_info', async () => {
      await expect(
        svc.adminReview('admin-1', 'biz-1', { decision: 'reject' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps request_info to more_information_required', async () => {
      await svc.adminReview('admin-1', 'biz-1', {
        decision: 'request_info',
        notes: 'Upload ID',
      });
      expect(prisma.businesses.updateMany.mock.calls[0][0].data.status).toBe(
        'more_information_required',
      );
    });

    it('cannot decide applications that are not under review', async () => {
      prisma.businesses.findUnique.mockResolvedValue({
        id: 'biz-1',
        owner_user_id: 'user-1',
        status: 'draft',
      });
      await expect(
        svc.adminReview('admin-1', 'biz-1', { decision: 'approve' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('prevents self-review', async () => {
      await expect(
        svc.adminReview('user-1', 'biz-1', { decision: 'approve' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
