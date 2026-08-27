/** Remove a UTF-8 BOM decoded as U+FEFF without altering any other bytes. */
export function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
