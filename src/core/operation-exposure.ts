import { isSourceIndexReadSurfaceEnabled, type OlympusConfig } from './config.ts';
import type { Operation } from './operations.ts';
import { isV04PublicOperation } from './public-surface.ts';

/**
 * Which surface is asking. Required, because a surface that forgets to declare
 * itself is exactly how tools that only that surface can serve ended up
 * advertised on the two that cannot.
 */
export type OperationSurface = 'native' | 'mcp' | 'cli';

export interface OperationExposureContext {
  config: OlympusConfig;
  surface: OperationSurface;
  activeModel?: unknown;
}

export function exposedOperations(
  operations: readonly Operation[],
  context: OperationExposureContext,
): Operation[] {
  return operations.filter((operation) => shouldExposeOperation(operation, context));
}

export function shouldExposeOperation(
  operation: Operation,
  context: OperationExposureContext,
): boolean {
  if (!isV04PublicOperation(context.surface, operation.name)) {
    return false;
  }
  if (operation.availability && !operation.availability(context.config)) {
    return false;
  }
  // Only the native tool factory can mint the authenticated route these need;
  // on any other surface the handler could do nothing but refuse.
  if (operation.requiresOpenClawSessionRoute && context.surface !== 'native') {
    return false;
  }
  if (operation.nativeExposure === 'sourceIndexAnswerDevOnly') {
    return context.config.sourceIndex.answerDevEnabled;
  }
  if (operation.nativeExposure === 'sourceIndexEnabledOnly') {
    return isSourceIndexReadSurfaceEnabled(context.config);
  }
  return true;
}
