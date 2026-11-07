/** Shared interpretation of /dashboard.json cards for in-machine and real-account canaries. */
export function sourceCard(view: { sources?: Array<{ provider?: string }> } | null | undefined, provider: string): any {
  return view?.sources?.find(card => card.provider === provider);
}
export function sourceConnected(card: any): boolean {
  return !!card && !['not_connected', 'needs_setup', 'awaiting_consent', 'reauth_required'].includes(String(card.connection?.state ?? 'not_connected'));
}
