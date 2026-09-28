import { Store, StoreValue } from '../flash-cache.js';

export class MapStore<T = unknown>
  extends Map<string, StoreValue<T>>
  implements Store<T> {}
