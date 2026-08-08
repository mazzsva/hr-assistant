export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function tokens(count: number): string {
  return count.toLocaleString("en-US");
}

export function cost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function similarity(value: number): string {
  return value.toFixed(3);
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
