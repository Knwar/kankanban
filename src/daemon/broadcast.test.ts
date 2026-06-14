import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WebSocket } from 'ws';
import { Broadcaster } from './broadcast.js';

/** Minimal stand-in for a ws WebSocket: records sends, captures the close handler. */
function fakeWs() {
  const sent: string[] = [];
  let closeHandler: (() => void) | undefined;
  return {
    sent,
    fireClose: () => closeHandler?.(),
    on(event: string, cb: () => void) {
      if (event === 'close') closeHandler = cb;
    },
    send(data: string) {
      sent.push(data);
    },
  };
}

describe('Broadcaster', () => {
  it('send reaches the matching project and catch-all (null) clients only', () => {
    const b = new Broadcaster();
    const p1 = fakeWs();
    const all = fakeWs();
    const p2 = fakeWs();
    b.add(p1 as unknown as WebSocket, 'p1');
    b.add(all as unknown as WebSocket, null);
    b.add(p2 as unknown as WebSocket, 'p2');

    b.send('p1', { type: 'x' });
    assert.equal(p1.sent.length, 1);
    assert.equal(all.sent.length, 1);
    assert.equal(p2.sent.length, 0);
    assert.deepEqual(JSON.parse(p1.sent[0]), { type: 'x' });
  });

  it('sendAll reaches every client regardless of project', () => {
    const b = new Broadcaster();
    const a = fakeWs();
    const c = fakeWs();
    b.add(a as unknown as WebSocket, 'p1');
    b.add(c as unknown as WebSocket, null);
    b.sendAll({ hello: 1 });
    assert.equal(a.sent.length, 1);
    assert.equal(c.sent.length, 1);
  });

  it('drops a client when its socket closes', () => {
    const b = new Broadcaster();
    const a = fakeWs();
    b.add(a as unknown as WebSocket, null);
    a.fireClose();
    b.sendAll({ x: 1 });
    assert.equal(a.sent.length, 0);
  });
});
