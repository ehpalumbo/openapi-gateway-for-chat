/**
 * Legacy memento-only registry removed in v0.1.0 — replaced by
 * {@link FileBackedApiRegistry} which keeps the lightweight index in
 * `Memento` and per-API registrations in `globalStorage`.
 *
 * This module re-exports the new registry under the legacy name so
 * existing imports (`MementoApiRegistry`) keep compiling on the
 * migration branch. Remove this alias once all consumers are updated.
 * @deprecated Use `FileBackedApiRegistry` from `./file-registry`.
 */
export { FileBackedApiRegistry as MementoApiRegistry } from './file-registry';
export { INDEX_KEY as REGISTRY_KEY } from './file-registry';
