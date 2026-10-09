/** Instance/slot patches only; never prototypes, DOM, commands, or global APIs. */
export class NativePatches {
  private readonly entries: Array<{
    target: object; key: string; wrapper: unknown; previous?: PropertyDescriptor;
  }> = [];

  static writable(target: object, key: string): boolean {
    const own = Object.getOwnPropertyDescriptor(target, key);
    return own ? "value" in own && own.writable === true : Object.isExtensible(target);
  }

  install(target: object, key: string, wrapper: unknown): void {
    if (!NativePatches.writable(target, key)) throw new Error("Unwritable native slot");
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, previous
      ? { ...previous, value: wrapper }
      : { value: wrapper, writable: true, configurable: true, enumerable: true });
    this.entries.push({ target, key, wrapper, previous });
  }

  ownsAll(): boolean {
    return this.entries.every(({ target, key, wrapper }) =>
      Object.getOwnPropertyDescriptor(target, key)?.value === wrapper);
  }

  restore(): void {
    for (const { target, key, wrapper, previous } of this.entries.reverse()) {
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) continue;
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    }
    this.entries.length = 0;
  }
}
