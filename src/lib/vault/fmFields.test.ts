import { describe, expect, it } from 'vitest';
import { fromFields, kindOf, parseList, switchKind, toFields, type FmField } from './fmFields';

describe('kindOf', () => {
  it('picks the editor a value needs', () => {
    expect(kindOf('a string')).toBe('text');
    expect(kindOf(8080)).toBe('text');
    expect(kindOf(true)).toBe('text');
    expect(kindOf(null)).toBe('text');
    expect(kindOf(['a', 'b'])).toBe('list');
    expect(kindOf([1, 2])).toBe('list');
    expect(kindOf({ nested: true })).toBe('yaml');
    expect(kindOf([{ nested: true }])).toBe('yaml');
    expect(kindOf([['deep']])).toBe('yaml');
  });
});

describe('toFields', () => {
  it('skips the keys notey owns', () => {
    const fields = toFields({ created: 'x', updated: 'y', tags: ['t'], aliases: ['a'], mine: 1 });
    expect(fields.map((f) => f.key)).toEqual(['mine']);
  });

  it('renders each kind for its editor', () => {
    const fields = toFields({
      author: 'me',
      port: 8080,
      people: ['ada', 'grace'],
      deploy: { host: 'example.com', port: 22 },
    });
    expect(fields).toMatchObject([
      { key: 'author', kind: 'text', value: 'me' },
      { key: 'port', kind: 'text', value: '8080' },
      { key: 'people', kind: 'list', value: 'ada, grace' },
      { key: 'deploy', kind: 'yaml' },
    ]);
    expect(fields[3]!.value).toContain('host: example.com');
  });
});

describe('fromFields', () => {
  it('round-trips untouched values with their exact type', () => {
    const data = { port: 8080, deploy: { host: 'example.com' }, people: ['ada'] };
    const { data: out, invalid } = fromFields(toFields(data));
    expect(out).toEqual(data);
    // The nested map is the same object, not a re-parse.
    expect(out['deploy']).toBe(data.deploy);
    expect(invalid).toEqual([]);
  });

  it('keeps a number a number when it is edited', () => {
    const fields = toFields({ port: 8080 });
    fields[0]!.value = '9090';
    expect(fromFields(fields).data).toEqual({ port: 9090 });
  });

  it('leaves a quoted string alone even when it looks numeric', () => {
    const fields = toFields({ version: '2' });
    fields[0]!.value = '3';
    expect(fromFields(fields).data).toEqual({ version: '3' });
  });

  it('splits a list field and drops blanks and duplicates', () => {
    const field: FmField = { key: 'people', kind: 'list', value: 'ada,  grace , , ada' };
    expect(fromFields([field]).data).toEqual({ people: ['ada', 'grace'] });
  });

  it('parses a yaml field into real structure', () => {
    const field: FmField = { key: 'deploy', kind: 'yaml', value: 'host: example.com\nport: 22' };
    expect(fromFields([field]).data).toEqual({ deploy: { host: 'example.com', port: 22 } });
  });

  it('keeps the old value when replacement yaml does not parse', () => {
    const fields = toFields({ deploy: { host: 'example.com' } });
    fields[0]!.value = 'host: : :';
    const { data, invalid } = fromFields(fields);
    expect(invalid).toEqual(['deploy']);
    expect(data['deploy']).toEqual({ host: 'example.com' });
  });

  it('ignores blank keys and refuses to shadow an owned one', () => {
    const rows: FmField[] = [
      { key: '  ', kind: 'text', value: 'nothing' },
      { key: 'tags', kind: 'list', value: 'sneaky' },
      { key: 'ok', kind: 'text', value: 'yes' },
    ];
    expect(fromFields(rows).data).toEqual({ ok: 'yes' });
  });
});

describe('switchKind', () => {
  it('text to list splits on commas', () => {
    const out = switchKind({ key: 'k', kind: 'text', value: 'a, b' }, 'list');
    expect(out).toMatchObject({ kind: 'list', value: 'a, b' });
    expect(fromFields([out]).data).toEqual({ k: ['a', 'b'] });
  });

  it('list to text joins them back', () => {
    const out = switchKind({ key: 'k', kind: 'list', value: 'a, b' }, 'text');
    expect(out).toMatchObject({ kind: 'text', value: 'a, b' });
  });

  it('list to yaml shows a real sequence', () => {
    const out = switchKind({ key: 'k', kind: 'list', value: 'a, b' }, 'yaml');
    expect(out.kind).toBe('yaml');
    expect(out.value).toBe('- a\n- b');
  });

  it('yaml to list keeps the items', () => {
    const out = switchKind({ key: 'k', kind: 'yaml', value: '- a\n- b' }, 'list');
    expect(out).toMatchObject({ kind: 'list', value: 'a, b' });
  });
});

describe('parseList', () => {
  it('is the same rule tags use', () => {
    expect(parseList('a, b\nc,,a')).toEqual(['a', 'b', 'c']);
    expect(parseList('   ')).toEqual([]);
  });
});
