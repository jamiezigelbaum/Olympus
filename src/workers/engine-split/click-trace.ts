export const CLICK_ID_HEADER = 'X-Olympus-Click-Id';
export const PRIVACY_ITEM_SET_PATH = '/dashboard/privacy/items/set';

export function readClickId(request: Request): string | undefined {
  const id = request.headers.get(CLICK_ID_HEADER);
  return id && id.length <= 80 && !/[^A-Za-z0-9_-]/.test(id) ? id : undefined;
}

export interface ClickTrace {
  id: string;
  ingress: number;
  attempts: number;
  requestId?: string;
}

export const clickTraces = new WeakMap<Request, ClickTrace>();

export function logClickTrace(
  id: string,
  requestId: string | undefined,
  point: 'ingress' | 'post_attempt' | 'control_receipt' | 'answer',
  role: 'front' | 'background',
  details: string,
  at = new Date().toISOString(),
): void {
  console.log(`${at} [olympus:click-trace] id=${id} request_id=${requestId ?? 'none'} point=${point} role=${role} ${details}`);
}
