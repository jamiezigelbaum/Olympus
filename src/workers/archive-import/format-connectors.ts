/**
 * Registers every archive format's connector with the shared format registry
 * (core/archive-formats.ts). The registry stays pure data; the readers live
 * with their formats. Idempotent: safe to call from every runtime build.
 */
import { registerMboxArchiveConnector } from './mbox/connector.ts';
import { registerWhatsAppArchiveConnector } from './whatsapp/connector.ts';

export function registerArchiveFormatConnectors(): void {
  registerMboxArchiveConnector();
  registerWhatsAppArchiveConnector();
}
