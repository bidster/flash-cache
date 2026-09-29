export function cloneValue<T>(value: T): T {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
      ? structuredClone(value)
      : value;
}
