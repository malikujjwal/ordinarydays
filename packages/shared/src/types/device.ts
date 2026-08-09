import type { IsoDate } from '../schemas/common.js';

/**
 * A registered push device — `USER#<userId>` / `DEVICE#<deviceId>` (`data-model.md` §3.2,
 * §4.0a, access pattern 15).
 *
 * One row per install, holding the Expo push token the reminder Lambda sends to (ADR-009).
 * It is **operational state, not user content**: nothing in the product renders a device, and
 * P5-16 says in as many words that there is no device-list screen in v1.
 *
 * The row's whole life is described by two endpoints and two cleanup paths:
 * `POST /v1/me/devices` writes it, `DELETE /v1/me/devices/:deviceId` removes it on sign-out
 * and on token rotation, a `DeviceNotRegistered` push receipt removes it (P5-13), and account
 * deletion removes all of them (`auth.md` §"account deletion" step 3). Rotation is
 * delete-then-create rather than an upsert, which is why the create body carries no
 * `deviceId` and why the response must return the one the server minted (P5-16 rule 2).
 */

/**
 * The platform whose push credentials this token addresses.
 *
 * **One member, deliberately.** iOS is the only platform that registers in v1: the web build
 * has no push at all — no service worker, no VAPID keys (`tech-stack.md` §"Push
 * notifications", `notifications.md` §6.2) — and there is no Android build. ADR-009 records
 * that Android will work through this same API when it arrives, and this is the change it
 * needs: one more member here and in the schema beside it. A union of one is honest about
 * what v1 accepts; a union of two would store a value nothing can produce and nothing reads.
 */
export type DevicePlatform = 'ios';

export interface Device {
  deviceId: string;
  /**
   * The Expo push token, `ExponentPushToken[…]`. A **device identifier** in the privacy
   * classification (`security-privacy.md` §3), retained until sign-out, device removal or
   * account deletion — which is the whole reason the `DELETE` exists and is called before
   * tokens are cleared rather than after.
   */
  expoPushToken: string;
  platform: DevicePlatform;
  /**
   * A human label for the install — `Ada's iPhone`. **Operator debugging only** (P5-16), and
   * optional because a simulator and a device whose owner has cleared the name both report
   * nothing, and neither is a reason to refuse a registration.
   */
  deviceName?: string;

  createdAt: IsoDate | string;
  updatedAt: IsoDate | string;
  schemaVersion: 1;
}

/**
 * What `POST /v1/me/devices` accepts — and nothing else (`api-contract.md` §2.1).
 *
 * No `deviceId`: the server mints it and returns it, because rotation is delete-then-create
 * and a client-supplied id would make the endpoint an upsert (P5-16 rule 2). No timestamps:
 * they are server-derived, and a server-derived field is never accepted from the client
 * (`security-privacy.md` §4.1 rule 4).
 */
export interface RegisterDeviceInput {
  expoPushToken: string;
  platform: DevicePlatform;
  deviceName?: string;
}
