import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDecisionIcs } from '../dist-electron/decisions.js';

test('decision calendar file is valid iCalendar with an alarm, the same on every platform', () => {
  const ics = buildDecisionIcs({
    id: 'abc',
    title: 'AhaStation 待确认：选方案 A, 还是 B; 还是 C\\D',
    notes: '推荐方案：A\n\n详情: C:\\Users\\me\\a.md',
    fileUrl: 'file:///Users/me/a.md',
    deadline: new Date('2026-11-04T10:00:00.000Z'),
    now: new Date('2026-11-03T08:30:15.123Z'),
  });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends with CRLF');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
  assert.match(unfolded, /\r\nUID:abc@ahastudio\r\n/);
  assert.match(unfolded, /\r\nDTSTAMP:20261103T083015Z\r\n/);
  assert.match(unfolded, /\r\nDTSTART:20261104T100000Z\r\nDTEND:20261104T103000Z\r\n/);
  assert.match(unfolded, /\r\nSUMMARY:AhaStation 待确认：选方案 A\\, 还是 B\; 还是 C\\\\D\r\n/);
  assert.match(unfolded, /\r\nDESCRIPTION:推荐方案：A\\n\\n详情: C:\\\\Users\\\\me\\\\a\.md\r\n/);
  assert.match(unfolded, /\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\n[^]*TRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n$/);
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line over 75 octets: ${line}`);
  }
});

test('long multi-byte summaries fold without splitting a character', () => {
  const ics = buildDecisionIcs({
    id: 'x', title: '决'.repeat(80), notes: '', fileUrl: 'file:///a', deadline: new Date(0), now: new Date(0),
  });
  const summary = ics.split('\r\n').filter((l, i, all) => l.startsWith('SUMMARY:') || (l.startsWith(' ') && all.slice(0, i).some((p) => p.startsWith('SUMMARY:')) && !all.slice(0, i).some((p) => p.startsWith('DESCRIPTION:'))));
  assert.ok(summary.length > 1);
  assert.equal(summary.map((l, i) => (i ? l.slice(1) : l)).join(''), `SUMMARY:${'决'.repeat(80)}`);
});
