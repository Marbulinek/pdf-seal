import { Injector, inject, type ProviderToken } from '@angular/core';

/**
 * Resolves `token` on first use instead of at construction. The document
 * orchestration and the feature stores call into each other (loading a file
 * resets every section; a section's action can reload the file), so direct
 * constructor injection would form a cycle. Must be called in an injection
 * context (field initializer / store factory).
 */
export function lazyInject<T>(token: ProviderToken<T>): () => T {
  const injector = inject(Injector);
  let instance: T | undefined;
  return () => (instance ??= injector.get(token));
}
