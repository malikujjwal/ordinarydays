declare const brand: unique symbol;

/** A structural brand prevents wall-clock values and absolute instants from mixing. */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type WallDate = Brand<string, 'WallDate'>;
export type WallTime = Brand<string, 'WallTime'>;
export type WallStamp = Brand<string, 'WallStamp'>;
export type Instant = Brand<string, 'Instant'>;
export type TimeZone = Brand<string, 'TimeZone'>;
