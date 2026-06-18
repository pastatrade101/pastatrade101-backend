import { snippe } from '../../config/env';
import { snippeProvider } from './snippe.provider';
import type { PaymentProvider } from './provider';

export type { CheckoutInput, CheckoutResult, NormalizedEvent, PaymentProvider } from './provider';

// Returns the active payment provider, or null when none is configured (in which
// case upgrades fall back to manual admin activation). Add more providers here.
export const getPaymentProvider = (): PaymentProvider | null => {
  if (snippe.configured) return snippeProvider;
  return null;
};

export const paymentsEnabled = (): boolean => getPaymentProvider() !== null;
