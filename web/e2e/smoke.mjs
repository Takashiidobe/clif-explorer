import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serve } from '../serve.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const executablePath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const { server, url } = await serve(dist);

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

const status = () => page.locator('#status').innerText();
const waitForStatus = (pattern, timeout = 60000) =>
  page.waitForFunction(
    ([source]) => new RegExp(source).test(document.querySelector('#status').textContent),
    [pattern.source],
    { timeout },
  );

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: process.env.SHOT ?? 'smoke-failure.png', fullPage: true });
    throw error;
  }
}

try {
  await step('loads and compiles the first example', async () => {
    await page.goto(url);
    await waitForStatus(/Compiled 1 function/);
  });

  await step('assembly tab lists real disassembly', async () => {
    await page.click('#tab-button-asm');
    const text = await page.locator('#asm').innerText();
    assert.match(text, /%add/);
    assert.match(text, /lea|add/);
    assert.match(text, /ret/);
  });

  await step('vcode view', async () => {
    await page.click('label:has(input[value=vcode])');
    assert.match(await page.locator('#asm').innerText(), /block0:/);
    await page.click('label:has(input[value=machine])');
  });

  await step('run tab returns 42', async () => {
    await page.click('#tab-button-run');
    await page.click('#run');
    await page.waitForSelector('#run-result:not([hidden])');
    assert.match(await page.locator('#run-result').innerText(), /Returned 42/);
  });

  await step('every target compiles and runs', async () => {
    for (const arch of ['aarch64', 'riscv64', 's390x', 'x86_64']) {
      await page.selectOption('#arch', arch);
      await waitForStatus(/Compiled 1 function/);
      await page.click('#run');
      await page.waitForFunction(() => /Returned 42/.test(document.querySelector('#run-result').textContent));
    }
  });

  await step('flags panel lists the target flags and applies a change', async () => {
    await page.selectOption('#arch', 'x86_64');
    await waitForStatus(/Compiled 1 function/);
    await page.click('#flags-summary');
    await page.fill('#flags-filter', 'opt_level');
    await page.selectOption('#flags-list select', 'speed');
    await waitForStatus(/Compiled 1 function/);
    assert.match(await page.locator('#flags-summary').innerText(), /\(1\)/);
  });

  await step('floating-point and stack argument examples run on every target', async () => {
    for (const arch of ['x86_64', 'aarch64', 'riscv64', 's390x']) {
      await page.selectOption('#arch', arch);
      await waitForStatus(/Compiled 1 function/);
      for (const [example, expected] of [
        ['f64 addition', '3.75'],
        ['f32 addition', '3.75'],
        ['f16 round-trip', '1.5'],
        ['mixed integer and float', '42.5'],
        ['stack arguments', '3.75'],
      ]) {
        await page.click('h1');
        await page.selectOption('#examples', example);
        await waitForStatus(/Compiled 1 function/);
        await page.click('#run');
        await page.waitForFunction((value) => {
          const result = document.querySelector('#run-result');
          return !result.hidden && !document.querySelector('#run').disabled && result.textContent.startsWith(`Returned ${value} (`);
        }, expected);
        if (example === 'f16 round-trip') {
          for (const value of ['-0', 'NaN', '-inf']) {
            await page.fill('#run-args input', value);
            await page.click('#run');
            const expected = value === '-inf' ? '-Infinity' : value;
            await page.waitForFunction((value) => !document.querySelector('#run').disabled && document.querySelector('#run-result').textContent.startsWith(`Returned ${value} (`), expected);
          }
        }
      }
    }
  });

  await step('trap example reports the trap code', async () => {
    await page.click('h1');
    await page.selectOption('#examples', 'division by zero');
    await waitForStatus(/Compiled 1 function/);
    await page.click('#run');
    await page.waitForFunction(() => /Trapped: int_divz/.test(document.querySelector('#run-result').textContent));
  });

  await step('i128 and vector examples run on every target', async () => {
    for (const arch of ['x86_64', 'aarch64', 'riscv64', 's390x']) {
      await page.selectOption('#arch', arch);
      await waitForStatus(/Compiled 1 function/);
      for (const [example, expected] of [
        ['i128 addition', '18446744073709551617'],
        ['i32x4 addition', '[11, 22, 33, -2147483648]'],
        ['f64x2 addition', '[3.75, -1.25]'],
      ]) {
        await page.click('h1');
        await page.selectOption('#examples', example);
        await waitForStatus(/Compiled 1 function/);
        await page.click('#run');
        await page.waitForFunction((value) => {
          const result = document.querySelector('#run-result');
          return !result.hidden && !document.querySelector('#run').disabled && result.textContent.startsWith(`Returned ${value} (`);
        }, expected);
      }
    }
  });

  await step('share links restore vector inputs without splitting lanes', async () => {
    await page.click('h1');
    await page.selectOption('#examples', 'i32x4 addition');
    await waitForStatus(/Compiled 1 function/);
    await page.click('#run');
    await page.waitForFunction(() => !document.querySelector('#run').disabled && document.querySelector('#run-result').textContent.startsWith('Returned [11, 22, 33, -2147483648]'));
    const shared = page.url();
    const other = await browser.newPage();
    other.on('pageerror', (error) => problems.push(`pageerror(vector share): ${error.message}`));
    try {
      await other.goto(shared);
      await other.waitForFunction(() => /Compiled 1 function/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
      assert.deepEqual(await other.locator('#run-args input').evaluateAll((inputs) => inputs.map((input) => input.value)), ['[1, 2, 3, 2147483647]', '[10, 20, 30, 1]']);
      await other.click('#run');
      await other.waitForFunction(() => document.querySelector('#run-result').textContent.startsWith('Returned [11, 22, 33, -2147483648]'));
    } finally {
      await other.close();
    }
  });

  await step('syntax errors are reported on the CLIF tab', async () => {
    await page.click('#tab-button-clif');
    await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('function %f( {'));
    await waitForStatus(/error/);
    assert.ok(!(await page.locator('#diagnostics').isHidden()));
  });

  await step('share link restores the program', async () => {
    await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue(
      'function %inc(i64) -> i64 {\nblock0(v0: i64):\n    v1 = iconst.i64 1\n    v2 = iadd v0, v1\n    return v2\n}\n'));
    await waitForStatus(/Compiled 1 function/);
    const shared = page.url();
    const other = await browser.newPage();
    other.on('pageerror', (error) => problems.push(`pageerror(shared): ${error.message}`));
    await other.goto(shared);
    await other.waitForFunction(() => /Compiled 1 function/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
    const code = await other.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    assert.match(code, /%inc/);
    await other.close();
  });

  assert.deepEqual(problems, [], `browser reported problems:\n${problems.join('\n')}`);
  console.log('smoke test passed');
} finally {
  await browser.close();
  server.close();
}
