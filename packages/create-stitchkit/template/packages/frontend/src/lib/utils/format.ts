import { formatDistanceToNow } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';

export type Currency = 'EUR' | 'RUB' | 'USD';

const currencySymbols: Record<Currency, string> = { EUR: '€', RUB: '₽', USD: '$' };

export function formatPrice(amount: number, currency: Currency): string {
  return `${currencySymbols[currency]}${Math.round(amount).toLocaleString()}`;
}

export function formatDateTime(value: Date | string): { date: string; time: string } {
  const date = typeof value === 'string' ? new Date(value) : value;
  return {
    date: new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date),
    time: new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(date),
  };
}

export function formatRelativeTime(date: string, locale: string): string {
  return formatDistanceToNow(new Date(date), {
    addSuffix: true,
    locale: locale === 'ru' ? ru : enUS,
  });
}
