import { Store, StoreValue } from '../flash-cache.js';

export class MapStore<T = any>
  extends Map<string, StoreValue<T>>
  implements Store<T> {}
