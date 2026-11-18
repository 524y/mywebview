// exe.test.js — npm test で実行（Win32 API の呼び出し自体は Windows でしか確認できない）
const test = require('node:test');
const assert = require('node:assert');
const koffi = require('koffi');
const { parseExe, SIGS, defineTypes } = require('./exe');

test('parseExe', () => {
  const base = 'C:\\list';
  assert.deepStrictEqual(parseExe('C:\\a\\b.exe', base), { file: 'C:\\a\\b.exe', args: [], text: 'C:\\a\\b.exe' });
  assert.deepStrictEqual(parseExe(' "C:\\Program Files\\x\\app.EXE" -f "a b" ', base), {
    file: 'C:\\Program Files\\x\\app.EXE', args: ['-f', 'a b'], text: '"C:\\Program Files\\x\\app.EXE" -f "a b"',
  });
  assert.deepStrictEqual(parseExe('C:\\Program Files\\x\\app.exe --x', base).args, ['--x']);
  assert.strictEqual(parseExe('C:\\my.exe.d\\app.exe', base).file, 'C:\\my.exe.d\\app.exe');
  assert.strictEqual(parseExe('tools\\v.exe', base).file, 'C:\\list\\tools\\v.exe');
  assert.strictEqual(parseExe('C:/tools/v.exe', base).file, 'C:\\tools\\v.exe');
  assert.deepStrictEqual(parseExe('C:\\t.exe /dir="C:\\Program Files\\x" ""', base), {
    file: 'C:\\t.exe', args: ['/dir=C:\\Program Files\\x', ''], text: 'C:\\t.exe "/dir=C:\\Program Files\\x" ""',
  });
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  assert.strictEqual(parseExe('%LOCALAPPDATA%\\Microsoft\\WindowsApps\\mspaint.exe', base, env).file,
    'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\mspaint.exe');
  assert.deepStrictEqual(parseExe('C:\\t.exe %UNDEFINED% 50%', base, env).args, ['%UNDEFINED%', '50%']);
  assert.strictEqual(parseExe('https://example.com/%LOCALAPPDATA%/a.exe', base, env), null);
  for (const s of ['https://example.com/setup.exe', 'example.com/setup.exe', 'app.exe', 'https://www.google.com/',
    'example.com', 'C:\\a\\b.exe.txt', '']) {
    assert.strictEqual(parseExe(s, base), null, s);
  }
});

test('Win32 API のプロトタイプが解釈できる', () => {
  defineTypes(koffi);
  for (const sig of Object.values(SIGS).flat()) koffi.proto(sig);
});
