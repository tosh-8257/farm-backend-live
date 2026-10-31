import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { IvorypayService } from './ivorypay.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { CacheService } from '../common/cache/cache.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class IvorypayDepositService {
  private readonly logger = new Logger(IvorypayDepositService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ivorypayService: IvorypayService,
    private readonly notificationsService: NotificationsService,
    private readonly websocket: WebsocketGateway,
    private readonly cache: CacheService,
  ) {}

  async getSupportedPaymentTokens() {
    const options = await this.ivorypayService.getSupportedPaymentOptions();
    const tokens = [...new Set(options.map((option) => option.token))].sort();
    return { success: true, data: tokens, options };
  }

  async createDeposit(userId: string, dto: any) {
    const amount = Number(dto.amount_fiat);
    if (!Number.isFinite(amount) || amount < 10) {
      throw new BadRequestException(
        `Invalid deposit amount. Minimum deposit is 10 ${dto.currency || 'KES'}`,
      );
    }

    const requestedToken =
      typeof dto.crypto === 'string' ? dto.crypto.trim().toUpperCase() : '';
    const requestedNetwork =
      typeof dto.chain === 'string' ? dto.chain.trim() : '';
    if (!requestedToken) {
      throw new BadRequestException(
        'Choose a cryptocurrency before creating an IvoryPay deposit',
      );
    }

    const options = await this.ivorypayService.getSupportedPaymentOptions();
    const tokenOptions = options.filter(
      (option) => option.token === requestedToken,
    );
    if (tokenOptions.length === 0) {
      throw new BadRequestException(
        'The selected crypto token is not enabled for IvoryPay',
      );
    }

    let selectedNetwork:
      | { token: string; network: string; networkName: string }
      | undefined;
    if (requestedNetwork) {
      selectedNetwork = tokenOptions.find(
        (option) => option.network === requestedNetwork,
      );
      if (!selectedNetwork) {
        throw new BadRequestException(
          'The selected crypto token and network are not enabled for IvoryPay',
        );
      }
    } else {
      selectedNetwork = tokenOptions[0];
    }
    if (!selectedNetwork) {
      throw new BadRequestException(
        'The selected crypto token has no enabled IvoryPay network',
      );
    }

    const reference = uuidv4();
    const deposit = await this.prisma.deposit.create({
      data: {
        userId,
        amount,
        fee: 0,
        total: amount,
        currency: 'FARM',
        paymentMethod: 'CRYPTO',
        provider: 'ivorypay',
        reference,
        status: 'PENDING',
        providerRef: reference,
      },
    });

    const amountUsd = Number((amount / 130).toFixed(2));
    let init: any;
    try {
      init = await this.ivorypayService.createPayment({
        amount: amountUsd,
        currency: 'USD',
        reference,
        email: dto.email || `${userId}@farm.app`,
        description: `Farm deposit ${amount.toFixed(4)} FARM → ${amountUsd.toFixed(2)} USD`,
        baseFiat: 'USD',
        crypto: requestedToken,
        chain: selectedNetwork.network,
        redirect_url: 'https://farmapp.africa/payment-callback',
        metadata: {
          provider: 'ivorypay',
          amount_farm: amount,
          amount_usd: amountUsd,
          amount_crypto: amountUsd,
          currency_fiat: 'USD',
          user_id: userId,
          payment_method: 'CRYPTO',
          crypto: requestedToken,
          chain: selectedNetwork.network,
        },
      });
    } catch (error) {
      await this.prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: 'FAILED' },
      });
      throw error;
    }

    const providerRef =
      init.providerReference ??
      init.data?.id ??
      init.data?.reference ??
      reference;
    await this.prisma.deposit.update({
      where: { id: deposit.id },
      data: { providerRef },
    });

    await this.prisma.transactions.create({
      data: {
        transaction_reference: reference,
        transaction_type: 'deposit',
        status: 'pending',
        amount,
        fee: 0,
        net_amount: amount,
        currency: 'FARM',
        description: `Crypto deposit via Ivorypay (${amount} FARM → ${amountUsd} USD)`,
        metadata: {
          provider: 'ivorypay',
          provider_ref: providerRef,
          amount_farm: amount,
          amount_usd: amountUsd,
          amount_crypto: amountUsd,
          currency_fiat: 'USD',
          user_id: userId,
          payment_method: 'CRYPTO',
          crypto: requestedToken,
          chain: selectedNetwork.network,
        },
      },
    });

    this.logger.log(
      `IvoryPay deposit created: reference=${reference} user=${userId}`,
    );

    return {
      success: true,
      data: {
        reference,
        payment_url:
          init.data?.payment_link || init.payment_link || init.checkout_url,
        authorization_url:
          init.data?.payment_link || init.payment_link || init.checkout_url,
      },
      message: 'Crypto deposit initiated via IvoryPay',
    };
  }

  async getStatus(reference: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { reference },
    });
    if (!deposit) {
      throw new BadRequestException('Deposit not found');
    }
    return {
      success: true,
      data: { reference, status: deposit.status, provider: deposit.provider },
    };
  }

  async verifyDeposit(userId: string, reference: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { reference, userId, provider: 'ivorypay' },
    });
    if (!deposit) {
      throw new NotFoundException('IvoryPay deposit not found');
    }
    if (deposit.status === 'SUCCESS') {
      return {
        success: true,
        data: { reference, status: 'completed', alreadyProcessed: true },
      };
    }
    if (deposit.status !== 'PENDING') {
      return { success: true, data: { reference, status: deposit.status } };
    }

    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    if (!transaction || transaction.transaction_type !== 'deposit') {
      throw new NotFoundException('Deposit transaction not found');
    }

    const metadata = (transaction.metadata as any) ?? {};
    const verified = await this.ivorypayService.verifyTransaction(
      reference,
      deposit.providerRef ?? metadata.provider_ref,
      [reference],
    );
    const verifiedData = verified?.data ?? verified;
    const verifiedStatus = (verifiedData?.status ?? verified?.status ?? '')
      .toString()
      .toLowerCase();

    if (!['success', 'completed'].includes(verifiedStatus)) {
      if (['failed', 'cancelled', 'expired'].includes(verifiedStatus)) {
        await this.handleWebhook(
          {
            event: 'payment.failed',
            reference,
            data: { ...verifiedData, reference, status: verifiedStatus },
          },
          true,
        );
      }
      return {
        success: true,
        data: { reference, status: verifiedStatus || deposit.status },
      };
    }

    await this.handleWebhook(
      {
        event: 'cryptoCollection.success',
        reference,
        data: { ...verifiedData, reference, status: 'SUCCESS' },
      },
      true,
      verifiedData,
    );

    const updatedDeposit = await this.prisma.deposit.findFirst({
      where: { reference, userId },
      select: { status: true },
    });
    return {
      success: true,
      data: {
        reference,
        status: updatedDeposit?.status ?? 'PENDING',
      },
    };
  }

  async handleWebhook(
    payload: any,
    verified = false,
    authenticatedTransaction?: any,
  ) {
    const reference = this.resolveReference(payload);
    if (!reference) {
      this.logger.warn('IvoryPay webhook received without reference');
      throw new BadRequestException('Missing IvoryPay reference');
    }

    this.logger.log(
      `IvoryPay webhook received: reference=${reference} event=${payload.event ?? payload.status}`,
    );
    if (!verified) {
      this.logger.warn(
        `IvoryPay webhook verification skipped for ${reference}`,
      );
      throw new BadRequestException('Signature verification required');
    }

    const deposit = await this.prisma.deposit.findFirst({
      where: { reference },
    });
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });

    if (!deposit || !transaction) {
      this.logger.warn(
        `IvoryPay webhook ignored: deposit/transaction not found for ${reference}`,
      );
      return { processed: false, reason: 'not_found' };
    }

    // If the IvoryPay webhook provides the provider's transaction id, persist it
    // so subsequent verification or stuck-deposit fixes use the provider's id
    // rather than our internal reference.
    try {
      const providerId =
        payload?.id ||
        payload?.data?.id ||
        payload?.data?.transaction_id ||
        payload?.data?.payment_id ||
        null;
      if (providerId && deposit.providerRef !== providerId) {
        const metadata = (transaction.metadata as any) ?? {};
        const updatedMetadata = { ...metadata, provider_ref: providerId };
        await this.prisma.$transaction(async (tx) => {
          await tx.deposit.update({
            where: { id: deposit.id },
            data: { providerRef: providerId },
          });
          await tx.transactions.update({
            where: { id: transaction.id },
            data: { metadata: updatedMetadata },
          });
        });
        // refresh local variables to reflect persisted change
        deposit.providerRef = providerId;
        transaction.metadata = updatedMetadata;
        this.logger.log(
          `IvoryPay webhook: synced provider id ${providerId} into deposit and transaction for ${reference}`,
        );
      }
    } catch (e) {
      this.logger.debug(
        `IvoryPay webhook: failed to sync provider id for ${reference}`,
        e,
      );
    }

    const depositStatus = deposit.status?.toString().toUpperCase();
    const txStatus = transaction.status?.toString().toLowerCase();
    const isSuccess = this.isSuccess(payload);
    const isFailure = this.isFailure(payload);

    if (depositStatus === 'SUCCESS' || txStatus === 'completed') {
      this.logger.log(`IvoryPay duplicate webhook ignored for ${reference}`);
      return { processed: true, duplicate: true, reference };
    }

    if (!isSuccess && !isFailure) {
      this.logger.log(
        `IvoryPay webhook ignored for ${reference}: unsupported event`,
      );
      return { processed: false, reason: 'unsupported_event' };
    }

    if (isFailure) {
      await this.prisma.deposit.update({
        where: { id: deposit.id },
        data: { status: 'FAILED' },
      });
      await this.prisma.transactions.update({
        where: { id: transaction.id },
        data: { status: 'failed' },
      });
      this.logger.warn(
        `IvoryPay deposit marked failed: reference=${reference}`,
      );
      return { processed: true, reference, status: 'failed' };
    }

    const metadata = (transaction.metadata as any) ?? {};
    const confirmedTransaction =
      authenticatedTransaction ??
      (await this.ivorypayService.verifyTransaction(
        reference,
        deposit.providerRef ?? metadata.provider_ref,
        [reference],
      ));
    const confirmedStatus = (
      confirmedTransaction?.status ??
      confirmedTransaction?.data?.status ??
      ''
    )
      .toString()
      .toUpperCase();
    if (confirmedStatus !== 'SUCCESS') {
      this.logger.warn(
        `IvoryPay success webhook not confirmed by status check: reference=${reference} status=${confirmedStatus || 'missing'}`,
      );
      return {
        processed: false,
        reason: 'provider_status_not_success',
        reference,
      };
    }

    if (
      confirmedTransaction.reference &&
      confirmedTransaction.reference !== reference
    ) {
      throw new BadRequestException(
        'IvoryPay verified reference does not match the pending deposit',
      );
    }

    const expectedToken = metadata.crypto?.toString()?.toUpperCase();
    const verifiedToken = (
      confirmedTransaction.token ??
      confirmedTransaction.crypto ??
      confirmedTransaction.currency ??
      ''
    )
      .toString()
      .toUpperCase();
    if (expectedToken && verifiedToken !== expectedToken) {
      this.logger.error(
        `IvoryPay verification token mismatch for ${reference}: expected=${expectedToken} verified=${verifiedToken || 'missing'}`,
      );
      throw new BadRequestException(
        'IvoryPay verified token does not match the pending deposit',
      );
    }

    const expectedCryptoAmount = Number(metadata.amount_crypto ?? NaN);
    const verifiedCryptoAmount = Number(
      confirmedTransaction.expectedAmountInCrypto ??
        confirmedTransaction.amountInCrypto ??
        NaN,
    );
    if (
      Number.isFinite(expectedCryptoAmount) &&
      expectedCryptoAmount > 0 &&
      (!Number.isFinite(verifiedCryptoAmount) ||
        verifiedCryptoAmount <= 0 ||
        Math.abs(expectedCryptoAmount - verifiedCryptoAmount) >
          Math.max(0.00000001, expectedCryptoAmount * 0.000001))
    ) {
      this.logger.error(
        `IvoryPay verification amount mismatch for ${reference}: expected=${expectedCryptoAmount} verified=${verifiedCryptoAmount}`,
      );
      throw new BadRequestException(
        'IvoryPay verified amount does not match the pending deposit',
      );
    }

    const result = await this.prisma.$transaction(async (tx: any) => {
      const currentDeposit = await tx.deposit.findFirst({
        where: { reference },
      });
      if (!currentDeposit) {
        throw new BadRequestException(
          'Deposit missing during IvoryPay processing',
        );
      }
      if (currentDeposit.status !== 'PENDING') {
        return { alreadyProcessed: true };
      }

      const claimedDeposit = await tx.deposit.updateMany({
        where: { id: currentDeposit.id, status: 'PENDING' },
        data: { status: 'SUCCESS' },
      });
      if (claimedDeposit.count !== 1) {
        return { alreadyProcessed: true };
      }

      let wallet = await tx.wallets.findFirst({
        where: { user_id: currentDeposit.userId, is_active: true },
      });
      if (!wallet) {
        wallet = await tx.wallets.create({
          data: {
            user_id: currentDeposit.userId,
            wallet_name: 'Main Wallet',
            wallet_type: 'user',
            wallet_address: uuidv4(),
            currency: currentDeposit.currency || 'FARM',
          },
        });
      }

      const previousBalance = Number(wallet.balance ?? 0);
      const creditAmount = Number(
        currentDeposit.amount ?? transaction.amount ?? 0,
      );

      const updatedWallet = await tx.wallets.update({
        where: { id: wallet.id },
        data: { balance: { increment: creditAmount } },
      });
      await tx.transactions.update({
        where: { id: transaction.id },
        data: {
          status: 'completed',
          receiver_wallet_id: wallet.id,
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount: creditAmount,
          balance_before: previousBalance,
          balance_after: previousBalance + creditAmount,
          description: `Deposit completed — ref: ${reference}`,
        },
      });
      await tx.audit_logs.create({
        data: {
          user_id: currentDeposit.userId,
          action: 'deposit_completed',
          entity_type: 'deposit',
          entity_id: currentDeposit.id,
          new_values: { reference, provider: 'ivorypay', amount: creditAmount },
        },
      });

      return {
        alreadyProcessed: false,
        balance: Number(
          updatedWallet.balance ?? previousBalance + creditAmount,
        ),
        previousBalance,
        creditAmount,
      };
    });

    if ((result as any).alreadyProcessed) {
      this.logger.log(`IvoryPay duplicate webhook ignored for ${reference}`);
      return { processed: true, duplicate: true, reference };
    }

    await Promise.all([
      this.cache.invalidateWallet(deposit.userId),
      this.cache.cacheInvalidatePattern(`dashboard:${deposit.userId}`),
      this.cache.cacheInvalidatePattern(`transactions:${deposit.userId}:*`),
    ]);

    this.websocket.emitBalanceUpdate(deposit.userId, (result as any).balance);
    this.websocket.emitTransactionUpdate(deposit.userId, {
      reference,
      status: 'SUCCESS',
    });

    await this.notificationsService.sendNotification(deposit.userId, {
      type: 'deposit_completed',
      title: 'Deposit completed',
      body: `Your crypto deposit of ${Number(deposit.amount ?? 0)} FARM has been credited to your wallet.`,
      entityId: deposit.id,
      metadata: { provider: 'ivorypay', reference },
    });

    this.logger.log(
      `IvoryPay wallet credited: reference=${reference} amount=${(result as any).creditAmount}`,
    );
    return { processed: true, reference, status: 'completed' };
  }

  private resolveReference(payload: any): string | null {
    const value =
      payload?.reference ||
      payload?.data?.reference ||
      payload?.data?.tx_ref ||
      payload?.data?.trxref ||
      payload?.data?.transaction_reference ||
      payload?.id;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private isSuccess(payload: any) {
    const event = payload?.event?.toString().toLowerCase() || '';
    const status =
      payload?.status?.toString().toLowerCase() ||
      payload?.data?.status?.toString().toLowerCase() ||
      '';
    return (
      [
        'cryptocollection.success',
        'payment.success',
        'transaction.completed',
        'success',
        'completed',
      ].includes(event) || ['success', 'completed'].includes(status)
    );
  }

  private isFailure(payload: any) {
    const event = payload?.event?.toString().toLowerCase() || '';
    const status =
      payload?.status?.toString().toLowerCase() ||
      payload?.data?.status?.toString().toLowerCase() ||
      '';
    return (
      [
        'cryptocollection.failed',
        'payment.failed',
        'transaction.failed',
        'failed',
        'cancelled',
        'expired',
        'abandoned',
        'declined',
        'reversed',
        'incomplete',
      ].includes(event) ||
      [
        'failed',
        'cancelled',
        'expired',
        'abandoned',
        'declined',
        'reversed',
        'incomplete',
      ].includes(status)
    );
  }
}
