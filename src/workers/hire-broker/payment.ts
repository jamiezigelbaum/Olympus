import { randomUUID } from 'node:crypto';

import type { HireBudget, SpendRecord } from './types.ts';
import { HireBrokerError } from './types.ts';

export interface PaymentQuoteRequest {
  handle: string;
  counterparty: string;
  endpoint: string;
  budget: HireBudget;
}

export interface PaymentQuote {
  quoteId: string;
  handle: string;
  amount: number;
  currency: string;
  expiresAt: string;
}

export interface PaymentCapReservation {
  reservationId: string;
  quoteId: string;
  amount: number;
  currency: string;
}

export interface PaymentReceipt {
  paymentReference: string;
  reservationId: string;
  amount: number;
  currency: string;
}

export interface PaymentProvider {
  quote(input: PaymentQuoteRequest): Promise<PaymentQuote>;
  reserveCaps(quote: PaymentQuote): Promise<PaymentCapReservation>;
  pay(quote: PaymentQuote, reservation: PaymentCapReservation): Promise<PaymentReceipt>;
  settle(receipt: PaymentReceipt, outcome: 'completed' | 'failed'): Promise<SpendRecord>;
}

export type MockPaymentIntent =
  | { operation: 'quote'; handle: string; amount: number; currency: string }
  | { operation: 'reserve_caps'; quoteId: string; amount: number; currency: string }
  | { operation: 'pay'; quoteId: string; reservationId: string; amount: number; currency: string }
  | { operation: 'settle'; paymentReference: string; outcome: 'completed' | 'failed' };

export class MockPaymentProvider implements PaymentProvider {
  readonly intents: MockPaymentIntent[] = [];

  constructor(
    private readonly options: {
      now?: () => Date;
      quotedAmount?: number;
      refuseCaps?: boolean;
    } = {},
  ) {}

  async quote(input: PaymentQuoteRequest): Promise<PaymentQuote> {
    const amount = this.options.quotedAmount ?? input.budget.amount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > input.budget.amount) {
      throw new HireBrokerError('payment_failed', 'Payment quote exceeds the approved budget.', 409);
    }
    this.intents.push({ operation: 'quote', handle: input.handle, amount, currency: input.budget.currency });
    return {
      quoteId: `mock_quote_${randomUUID()}`,
      handle: input.handle,
      amount,
      currency: input.budget.currency,
      expiresAt: new Date(this.now().getTime() + 60_000).toISOString(),
    };
  }

  async reserveCaps(quote: PaymentQuote): Promise<PaymentCapReservation> {
    if (this.options.refuseCaps) {
      throw new HireBrokerError('payment_cap_refused', 'Payment cap reservation was refused.', 409);
    }
    this.intents.push({
      operation: 'reserve_caps',
      quoteId: quote.quoteId,
      amount: quote.amount,
      currency: quote.currency,
    });
    return {
      reservationId: `mock_cap_${randomUUID()}`,
      quoteId: quote.quoteId,
      amount: quote.amount,
      currency: quote.currency,
    };
  }

  async pay(quote: PaymentQuote, reservation: PaymentCapReservation): Promise<PaymentReceipt> {
    if (reservation.quoteId !== quote.quoteId
      || reservation.amount !== quote.amount
      || reservation.currency !== quote.currency) {
      throw new HireBrokerError('payment_failed', 'Payment reservation does not match the quote.', 409);
    }
    this.intents.push({
      operation: 'pay',
      quoteId: quote.quoteId,
      reservationId: reservation.reservationId,
      amount: quote.amount,
      currency: quote.currency,
    });
    return {
      paymentReference: `mock_payment_${randomUUID()}`,
      reservationId: reservation.reservationId,
      amount: quote.amount,
      currency: quote.currency,
    };
  }

  async settle(receipt: PaymentReceipt, outcome: 'completed' | 'failed'): Promise<SpendRecord> {
    this.intents.push({ operation: 'settle', paymentReference: receipt.paymentReference, outcome });
    return {
      handle: '',
      amount: receipt.amount,
      currency: receipt.currency,
      recordedAt: this.now().toISOString(),
      outcome,
      paymentReference: receipt.paymentReference,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
