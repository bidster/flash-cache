import type { Store, StoreValue } from '../types.js';

export class MapStore<T = unknown> extends Map<string, StoreValue<T>> implements Store<T> {}
