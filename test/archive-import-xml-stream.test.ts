// The shared streaming XML reader (src/workers/archive-import/xml-stream.ts):
// records handed out whole from their path, the same whatever the chunking,
// large text reported as byte ranges and never held, oversize records passed
// over, damage thrown after the records whole before it, and resuming from a
// record's end. Every document here is invented.

import { describe, expect, test } from 'bun:test';
import type { ArchiveByteSource } from '../src/workers/archive-import/byte-source.ts';
import { fileByteSource } from '../src/workers/archive-import/byte-source.ts';
import {
  XmlStreamError,
  XmlStreamReader,
  decodeXmlEntities,
  xmlChild,
  xmlText,
  type XmlStreamEvent,
} from '../src/workers/archive-import/xml-stream.ts';

const enc = new TextEncoder();

/** A source over `bytes` from `start`, in chunks of `size`. */
function chunked(bytes: Uint8Array, size: number, start = 0): ArchiveByteSource {
  return fileByteSource({ size: bytes.length, readAt: (offset, length) => bytes.slice(offset, offset + length) }, { start, chunkBytes: size });
}

function all(reader: XmlStreamReader): XmlStreamEvent[] {
  const out: XmlStreamEvent[] = [];
  for (;;) {
    const event = reader.next();
    if (!event) return out;
    out.push(event);
  }
}

const DOC = [
  '﻿<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE en-export SYSTEM "http://example.invalid/export.dtd" [ <!ENTITY x "y"> ]>',
  '<!-- a comment with <tags> and -- inside -->',
  '<en-export export-date="20240101T000000Z" application="Fixture">',
  '  <note><title>First &amp; &lt;best&gt; &#233;t&#xE9;</title>',
  '    <content><![CDATA[<en-note><div>Hello ]] world ]]] &nbsp;</div></en-note>]]></content>',
  '    <tag>alpha</tag><tag>beta</tag>',
  '    <resource><data encoding="base64">QUJD\nREVG</data><mime>image/png</mime></resource>',
  '  </note>',
  '  <?pi ignored?>',
  "  <note><title a='1' b=\"2\">Second</title><empty/></note>",
  '</en-export>',
  '',
].join('\n');

function summary(events: readonly XmlStreamEvent[], bytes: Uint8Array): unknown[] {
  return events.map((event) => {
    if (event.kind === 'oversize') return { oversize: [event.start, event.end] };
    const element = event.element;
    const data = xmlChild(xmlChild(element, 'resource') ?? { name: '', attributes: {}, children: [] }, 'data');
    return {
      title: xmlText(xmlChild(element, 'title')!),
      content: xmlChild(element, 'content') ? xmlText(xmlChild(element, 'content')!) : undefined,
      tags: element.children.filter((child) => typeof child !== 'string' && child.name === 'tag').map((child) => xmlText(child as never)),
      data: data?.ranges?.map((range) => new TextDecoder().decode(bytes.slice(range.start, range.end))),
      dataText: data ? xmlText(data) : undefined,
      span: new TextDecoder().decode(bytes.slice(event.start, event.end)).slice(0, 6),
    };
  });
}

describe('records', () => {
  const bytes = enc.encode(DOC);
  const expected = [
    {
      title: 'First & <best> été',
      content: '<en-note><div>Hello ]] world ]]] &nbsp;</div></en-note>',
      tags: ['alpha', 'beta'],
      data: ['QUJD\nREVG'],
      dataText: '',
      span: '<note>',
    },
    { title: 'Second', content: undefined, tags: [], data: undefined, dataText: undefined, span: '<note>' },
  ];

  test('every split of the document into chunks gives the same records', () => {
    for (let size = 1; size <= bytes.length + 1; size += size < 40 ? 1 : 17) {
      const reader = new XmlStreamReader(chunked(bytes, size), { recordPaths: [['en-export', 'note']], rangeElements: ['data'], maxRecordBytes: 1 << 20 });
      const events = all(reader);
      expect(summary(events, bytes), `chunk ${size}`).toEqual(expected);
      expect(reader.rootName).toBe('en-export');
    }
  });

  test('attributes, and the end offset of a record resumes the next one', () => {
    const first = new XmlStreamReader(chunked(bytes, 64), { recordPaths: [['en-export', 'note']], rangeElements: ['data'], maxRecordBytes: 1 << 20 });
    const one = first.next()!;
    expect(one.kind).toBe('record');
    expect(first.open).toEqual(['en-export']);
    const resumed = new XmlStreamReader(chunked(bytes, 7, one.end), { recordPaths: [['en-export', 'note']], rangeElements: ['data'], maxRecordBytes: 1 << 20, open: ['en-export'] });
    const rest = all(resumed);
    expect(summary(rest, bytes)).toEqual([expected[1]]);
    const title = xmlChild((rest[0] as Extract<XmlStreamEvent, { kind: 'record' }>).element, 'title')!;
    expect(title.attributes).toEqual({ a: '1', b: '2' });
  });

  test('a record past the limit is passed over, its ranged text not counted, and the next one still read', () => {
    const big = `<en-export><note><title>${'x'.repeat(5000)}</title></note><note><title>ok</title><resource><data>${'A'.repeat(100_000)}</data></resource></note></en-export>`;
    const doc = enc.encode(big);
    const events = all(new XmlStreamReader(chunked(doc, 333), { recordPaths: [['en-export', 'note']], rangeElements: ['data'], maxRecordBytes: 1000 }));
    expect(events.map((event) => event.kind)).toEqual(['oversize', 'record']);
    const data = xmlChild(xmlChild((events[1] as Extract<XmlStreamEvent, { kind: 'record' }>).element, 'resource')!, 'data')!;
    expect(data.ranges!.reduce((sum, range) => sum + range.end - range.start, 0)).toBe(100_000);
  });

  test('ranged text with an entity reference says so', () => {
    const doc = enc.encode('<r><n><data>AB&amp;CD</data></n></r>');
    const [event] = all(new XmlStreamReader(chunked(doc, 3), { recordPaths: [['r', 'n']], rangeElements: ['data'], maxRecordBytes: 1000 }));
    expect(xmlChild((event as Extract<XmlStreamEvent, { kind: 'record' }>).element, 'data')!.rangeEntities).toBe(true);
  });
});

describe('damage', () => {
  const cases: Array<[string, string, number]> = [
    ['an end tag that closes another element', '<r><n><a>1</b></n></r>', 0],
    ['a document cut short', '<r><n>1</n><n>2', 1],
    ['a document cut short inside a CDATA section', '<r><n>1</n><n><![CDATA[abc', 1],
    ['a tag that is not XML', '<r><n>1</n><n <></n></r>', 1],
    ['text after the root', '<r><n>1</n></r>junk', 1],
  ];
  for (const [name, text, whole] of cases) {
    test(`${name}: the records whole before it come first, then the error`, () => {
      for (const size of [1, 2, 5, 1000]) {
        const reader = new XmlStreamReader(chunked(enc.encode(text), size), { recordPaths: [['r', 'n']], maxRecordBytes: 1000 });
        const got: XmlStreamEvent[] = [];
        let error: unknown;
        try {
          for (;;) {
            const event = reader.next();
            if (!event) break;
            got.push(event);
          }
        } catch (caught) {
          error = caught;
        }
        expect(got.length, `${name} at ${size}`).toBe(whole);
        expect(error, `${name} at ${size}`).toBeInstanceOf(XmlStreamError);
      }
    });
  }

  test('nesting past the bound stops the read', () => {
    const deep = `<r>${'<a>'.repeat(300)}${'</a>'.repeat(300)}</r>`;
    expect(() => all(new XmlStreamReader(chunked(enc.encode(deep), 64), { recordPaths: [['r', 'n']], maxRecordBytes: 1000 }))).toThrow(XmlStreamError);
  });

  test('an empty document has no root and no records', () => {
    const reader = new XmlStreamReader(chunked(enc.encode('  \n'), 4), { recordPaths: [['r', 'n']], maxRecordBytes: 1000 });
    expect(all(reader)).toEqual([]);
    expect(reader.rootName).toBeUndefined();
  });
});

test('entities: the five predefined ones and numeric references; any other is kept as written', () => {
  expect(decodeXmlEntities('&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&nbsp;&#0;&#xD800;')).toBe('<>&"\'AB&nbsp;&#0;&#xD800;');
});
