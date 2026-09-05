import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const script = readFileSync(resolve('e2e/scripts/tap-ios-while-loading.js'), 'utf8');
const id = 'calendar-cell-2027-09-16';
const cell = {
  identifier: id,
  enabled: true,
  frame: { X: 120, Y: 350, Width: 50, Height: 52 },
};
const loading = { label: 'Loading calendar' };

function run(children: unknown[], snapshotStatus = 200) {
  const touches: unknown[] = [];
  const output: { calendarRaceTaps?: string[] } = {};
  const execute = () =>
    runInNewContext(script, {
      IOS_DRIVER_URL: 'http://127.0.0.1:22087',
      ELEMENT_ID: id,
      output,
      http: {
        post(url: string, options: { body: string }) {
          const path = new URL(url).pathname;
          if (path === '/viewHierarchy') {
            expect(JSON.parse(options.body)).toEqual({
              appIds: ['app.ordinarydays.ios.local'],
              excludeKeyboardElements: true,
            });
            return {
              status: snapshotStatus,
              body: JSON.stringify({ axElement: { children } }),
            };
          }
          if (path !== '/touch') throw new Error(`Unexpected route ${path}`);
          touches.push(JSON.parse(options.body));
          return { status: 200, body: '{}' };
        },
      },
    });
  return { execute, touches, output };
}

describe('Maestro in-flight iOS calendar selection', () => {
  it('resolves the accessible cell from the current hierarchy and taps its center', () => {
    const { execute, touches, output } = run([loading, { children: [cell] }]);
    execute();
    expect(touches).toEqual([{ x: 145, y: 376 }]);
    expect(output.calendarRaceTaps).toEqual([id]);
  });
  it.each([
    { name: 'request already settled', children: [cell], message: /still be loading/ },
    { name: 'missing cell', children: [loading], message: /found 0/ },
    {
      name: 'disabled cell',
      children: [loading, { ...cell, enabled: false }],
      message: /found 0/,
    },
    { name: 'ambiguous cell', children: [loading, cell, cell], message: /found 2/ },
    {
      name: 'unmeasured cell',
      children: [loading, { ...cell, frame: { X: 0, Y: 0, Width: 0, Height: 0 } }],
      message: /Invalid accessible bounds/,
    },
  ])('refuses a tap when $name', ({ children, message }) => {
    const { execute, touches } = run(children);
    expect(execute).toThrow(message);
    expect(touches).toEqual([]);
  });
  it('fails clearly when the driver protocol is unavailable', () => {
    const { execute, touches } = run([], 404);
    expect(execute).toThrow(/check IOS_DRIVER_URL and driver version/);
    expect(touches).toEqual([]);
  });
});
