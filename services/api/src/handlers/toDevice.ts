import type { Device } from '@od/shared/types';

/**
 * The `Device` a response carries — built **field by field, never by spreading**.
 *
 * Same rule and same reason as `toUser`: a stored row carries `pk`, `sk` and `entity`
 * alongside the domain fields, and every future storage attribute arrives on it too
 * (`agent-playbook.md` §6.11, `data-model.md` §8).
 *
 * `expoPushToken` **is** projected, and that is deliberate rather than an oversight. It is
 * classified as a device identifier belonging to the caller, not to anyone else
 * (`security-privacy.md` §3), and the row lives in the caller's own partition — so the only
 * person who can read it is the person whose device produced it, on the request that just
 * sent it. Echoing it is what lets a client confirm the server stored the token it meant,
 * which is the one thing it cannot otherwise verify about a fire-and-forget registration.
 */
export function toDevice(device: Device): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    expoPushToken: device.expoPushToken,
    platform: device.platform,
    ...(device.deviceName === undefined ? {} : { deviceName: device.deviceName }),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    schemaVersion: device.schemaVersion,
  };
}
