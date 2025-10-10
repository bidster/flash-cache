export function jitter(ttl: number, percent: number = 0.1): number {
  const jitter = Math.floor(Math.random() * (ttl * percent));
  return ttl - jitter;
}
