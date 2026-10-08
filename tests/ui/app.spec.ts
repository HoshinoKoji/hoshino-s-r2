import { test, expect, type Page } from '@playwright/test';

const info = (key: string, size = 12) => ({ key, size, uploaded: '2026-10-08T09:00:00Z', etag: '"fixed-etag"', contentType: 'text/plain' });

async function mockFiles(page: Page) {
  const objects = new Map([['alpha.txt', info('alpha.txt')], ['beta.json', info('beta.json')], ['目录/文件 + #%.txt', info('目录/文件 + #%.txt')]]);
  const deletes: string[] = [];
  const writes: string[] = [];
  await page.route('**/api/v1/buckets/documents/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const key = url.searchParams.get('key') ?? '';
    const kind = url.pathname.split('/').pop();
    if (kind === 'objects') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const flat = url.searchParams.get('delimiter') === '';
      const matches = [...objects.values()].filter(item => item.key.startsWith(prefix));
      const prefixes = flat ? [] : [...new Set(matches.filter(item => item.key.slice(prefix.length).includes('/'))
        .map(item => prefix + item.key.slice(prefix.length).split('/')[0] + '/'))];
      await route.fulfill({ json: { objects: matches.filter(item => flat || !item.key.slice(prefix.length).includes('/')), prefixes, truncated: false, cursor: null } });
    } else if (kind === 'metadata') {
      await route.fulfill(objects.has(key) ? { json: objects.get(key) } : { status: 404, json: { error: { message: 'Object not found' } } });
    } else if (kind === 'object' && request.method() === 'DELETE') {
      deletes.push(key); objects.delete(key); await route.fulfill({ status: 204 });
    } else if (kind === 'object' && request.method() === 'PUT') {
      writes.push(key); objects.set(key, info(key, request.postDataBuffer()?.length ?? 0)); await route.fulfill({ status: 201, json: objects.get(key) });
    } else await route.continue();
  });
  return { objects, deletes, writes };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as typeof window & { cspViolations: string[] };
    target.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      target.cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as typeof window & { cspViolations?: string[] }).cspViolations ?? [])).toEqual([]);
});

test('themes persist, file details and command dialogs work under the real Worker CSP', async ({ page, context }) => {
  await mockFiles(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const response = await page.goto('/');
  expect(response!.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(response!.headers()['content-security-policy']).not.toContain('unsafe-inline');
  await expect(page.getByRole('heading', { name: '文档', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('menuitem', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  const details = page.getByRole('dialog', { name: '文件详情' });
  await expect(details).toContainText('"fixed-etag"');
  await expect(details.getByRole('link', { name: '下载', exact: true })).toHaveAttribute('href', /object\?key=alpha\.txt/);
  await expect(details.getByRole('button', { name: '分片下载' })).toBeVisible();
  await expect(details.getByRole('button', { name: '下载命令' })).toBeVisible();
  await details.getByRole('button', { name: '复制 KEY' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha.txt');
  await page.keyboard.press('Escape');
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'alpha.txt 更多操作' }).click();
  await page.getByRole('menuitem', { name: 'aria2 命令' }).click();
  const dialog = page.getByRole('dialog', { name: '命令行下载' });
  await expect(dialog.getByRole('textbox', { name: '下载命令' })).toHaveValue(/aria2c.*alpha\.txt/);
  await dialog.getByRole('tab', { name: 'curl', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '下载命令' })).toHaveValue(/curl --fail/);
  await dialog.getByRole('button', { name: '复制命令' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^curl /);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('menuitem', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.getByRole('menuitem', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
});

test('selection is indeterminate, deleting requires confirmation and navigation handles special keys', async ({ page }) => {
  const state = await mockFiles(page);
  await page.goto('/');
  await page.getByRole('checkbox', { name: '选择 alpha.txt', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: '全选已加载文件' })).toHaveJSProperty('indeterminate', true);
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除 1 个文件？' });
  await expect(dialog).toContainText('alpha.txt');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  expect(state.deletes).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(state.deletes).toEqual([]);
  await page.getByRole('checkbox', { name: '全选已加载文件' }).check();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toHaveCount(0);
  expect(state.deletes.sort()).toEqual(['alpha.txt', 'beta.json']);
  await page.getByRole('button', { name: '目录/', exact: true }).click();
  await expect(page.getByRole('button', { name: '文件 + #%.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '目录/文件 + #%.txt 更多操作' }).click();
  await page.getByRole('menuitem', { name: 'curl 命令' }).click();
  await expect(page.getByRole('textbox', { name: '下载命令' })).toHaveValue(/%E7%9B%AE%E5%BD%95.*%23%25/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '根目录', exact: true }).click();
  await page.getByRole('textbox', { name: '对象前缀' }).fill('目录/');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByRole('button', { name: '文件 + #%.txt', exact: true })).toBeVisible();
});

test('multi-file uploads ask about each overwrite and render completed tasks', async ({ page }) => {
  const state = await mockFiles(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  await page.getByLabel('选择上传文件').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha replacement') },
    { name: 'beta.json', mimeType: 'application/json', buffer: Buffer.from('{}') },
    { name: 'fresh.txt', mimeType: 'text/plain', buffer: Buffer.from('new') },
  ]);
  const uploadDialog = page.getByRole('dialog', { name: '上传文件', exact: true });
  await expect(uploadDialog.getByRole('textbox', { name: '目标路径前缀' })).toHaveValue('');
  expect(state.writes).toEqual([]);
  await uploadDialog.getByRole('button', { name: '开始上传' }).click();
  const dialog = page.getByRole('dialog', { name: '覆盖已有文件？' });
  await expect(dialog).toContainText('alpha.txt');
  expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toContainText('beta.json');
  await dialog.getByRole('button', { name: '确认覆盖', exact: true }).click();
  const tasks = page.getByRole('region', { name: '传输任务' });
  await expect(tasks.getByText('已完成', { exact: true })).toHaveCount(2);
  expect(state.writes).toEqual(['beta.json', 'fresh.txt']);
  await expect(tasks.getByRole('progressbar')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'fresh.txt', exact: true })).toBeVisible();
  await tasks.getByRole('button', { name: '清除已结束' }).click();
  await expect(tasks.getByText('暂无传输任务')).toBeVisible();
});

test('successful uploads refresh the visible listing once and completed transfer speed stays fixed', async ({ page }) => {
  await mockFiles(page);
  const listings: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/documents/objects')) listings.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  expect(listings).toHaveLength(1);
  await page.getByLabel('选择上传文件').setInputFiles({ name: 'latest.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
  await page.getByRole('dialog', { name: '上传文件' }).getByRole('button', { name: '开始上传' }).click();
  const tasks = page.getByRole('region', { name: '传输任务' });
  await expect(tasks.getByText('已完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'latest.txt', exact: true })).toBeVisible();
  expect(listings).toHaveLength(2);
  const speed = tasks.getByText(/平均 .*\/s/);
  const completedSpeed = await speed.textContent();
  await page.waitForTimeout(1200); // The app's 1-second repaint used to make a completed task's average speed keep falling.
  await expect(speed).toHaveText(completedSpeed!);
});

test('upload completion refreshes the currently visible prefix after navigating during transfer', async ({ page }) => {
  await mockFiles(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  const listings: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/documents/objects')) listings.push(url.searchParams.get('prefix') ?? '');
  });
  await page.route('**/api/v1/buckets/documents/object?key=delayed.txt', async route => {
    requestStarted();
    await gate;
    await route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '目录/', exact: true })).toBeVisible();
  await page.getByLabel('选择上传文件').setInputFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
  await page.getByRole('dialog', { name: '上传文件' }).getByRole('button', { name: '开始上传' }).click();
  await started;
  await page.getByRole('button', { name: '目录/', exact: true }).click();
  await expect(page.getByRole('button', { name: '文件 + #%.txt', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: '传输任务' }).getByText('已完成', { exact: true })).toBeVisible();
  await expect.poll(() => listings).toEqual(['', '目录/', '目录/']);
  await expect(page.getByRole('button', { name: 'delayed.txt', exact: true })).toHaveCount(0);
});

test('upload paths default to the current directory, cancellation resets selection and an empty prefix targets the root', async ({ page }) => {
  const state = await mockFiles(page);
  await page.goto('/');
  await page.getByRole('button', { name: '目录/', exact: true }).click();
  await expect(page.getByRole('button', { name: '文件 + #%.txt', exact: true })).toBeVisible();
  const file = { name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new') };
  const dialog = page.getByRole('dialog', { name: '上传文件', exact: true });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '上传文件', exact: true }).click();
  await (await chooser).setFiles(file);
  await expect(dialog.getByRole('textbox', { name: '目标路径前缀' })).toHaveValue('目录/');
  await expect(dialog.getByText('目录/new.txt', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '根目录', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(state.writes).toEqual([]);
  await expect(page.getByRole('button', { name: '根目录', exact: true })).toBeEnabled();
  // Selecting the same file again should open a fresh dialog.
  await page.getByLabel('选择上传文件').setInputFiles(file);
  await expect(dialog.getByRole('textbox', { name: '目标路径前缀' })).toHaveValue('目录/');
  await dialog.getByRole('button', { name: '开始上传' }).click();
  await expect.poll(() => state.writes).toEqual(['目录/new.txt']);
  await page.getByLabel('选择上传文件').setInputFiles(file);
  await dialog.getByRole('textbox', { name: '目标路径前缀' }).fill('');
  await expect(dialog.getByText('new.txt', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '开始上传' }).click();
  await expect.poll(() => state.writes).toEqual(['目录/new.txt', 'new.txt']);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: 'new.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '对象前缀' })).toHaveValue('目录/');
});

test('custom upload paths normalize the trailing slash and check overwrites at the final multi-file keys', async ({ page }) => {
  const state = await mockFiles(page);
  state.objects.set('备份/2026 + # %/alpha.txt', info('备份/2026 + # %/alpha.txt'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  await page.getByLabel('选择上传文件').setInputFiles([
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('replacement') },
    { name: 'beta.json', mimeType: 'application/json', buffer: Buffer.from('{}') },
  ]);
  const dialog = page.getByRole('dialog', { name: '上传文件', exact: true });
  await dialog.getByRole('textbox', { name: '目标路径前缀' }).fill('备份/2026 + # %');
  await expect(dialog.getByText('备份/2026 + # %/alpha.txt', { exact: true })).toBeVisible();
  await expect(dialog.getByText('备份/2026 + # %/beta.json', { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await dialog.getByRole('button', { name: '开始上传' }).click();
  const overwrite = page.getByRole('dialog', { name: '覆盖已有文件？' });
  await expect(overwrite).toContainText('备份/2026 + # %/alpha.txt');
  await overwrite.getByRole('button', { name: '确认覆盖' }).click();
  await expect(page.getByRole('region', { name: '传输任务' }).getByText('已完成', { exact: true })).toHaveCount(2);
  expect(state.writes).toEqual(['备份/2026 + # %/alpha.txt', '备份/2026 + # %/beta.json']);
  await expect(page.getByRole('textbox', { name: '对象前缀' })).toHaveValue('');
});

test('upload path validation measures the final key in UTF-8 bytes before starting requests', async ({ page }) => {
  const state = await mockFiles(page);
  const metadata: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/metadata')) metadata.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  await page.getByLabel('选择上传文件').setInputFiles({ name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
  const dialog = page.getByRole('dialog', { name: '上传文件', exact: true });
  await dialog.getByRole('textbox', { name: '目标路径前缀' }).fill('界'.repeat(339));
  await expect(dialog).toContainText('1024 个 UTF-8 字节');
  await expect(dialog.getByRole('button', { name: '开始上传' })).toBeDisabled();
  expect(metadata).toEqual([]);
  expect(state.writes).toEqual([]);
  await dialog.getByRole('textbox', { name: '目标路径前缀' }).fill('界'.repeat(338));
  await expect(dialog.getByRole('button', { name: '开始上传' })).toBeEnabled();
  await dialog.getByRole('button', { name: '开始上传' }).click();
  await expect.poll(() => state.writes).toEqual(['界'.repeat(338) + '/alpha.txt']);
});

test('mobile navigation switches buckets without causing viewport overflow', async ({ page }) => {
  await mockFiles(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '文档', exact: true })).toBeVisible();
  const brand = page.getByRole('img', { name: 'Hoshino R2' });
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAttribute('src', '/favicon.svg');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
  await expect.poll(() => brand.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: /归档 archives/ }).click();
  await expect(page.getByRole('heading', { name: '归档', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(brand).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAPI 文档' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'OpenAPI 文档' })).toHaveAttribute('href', '/api/v1/openapi.json');
  await expect(page.getByRole('link', { name: 'OpenAPI 文档' })).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: '打开导航' }).click();
  const sidebar = page.getByLabel('存储桶选择', { exact: true });
  await expect(sidebar.getByRole('link')).toHaveCount(0);
  await expect(sidebar.getByRole('combobox')).toHaveCount(0);
  await expect(sidebar).not.toContainText('本地开发模式');
  await page.getByRole('button', { name: '传输设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  const settings = page.getByRole('dialog', { name: '传输设置', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('slider', { name: '分片大小' })).toHaveAttribute('aria-valuetext', '16 MiB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  await expect(page.getByRole('button', { name: '传输设置', exact: true })).toBeFocused();
});

for (const width of [1440, 320]) {
  test(`bucket-only sidebar remains scrollable with hidden scrollbars at ${width}px`, async ({ page }) => {
    await mockFiles(page);
    await page.setViewportSize({ width, height: 640 });
    await page.route('**/api/v1/buckets', route => route.fulfill({ json: {
      identity: '本地开发', buckets: [{ id: 'documents', label: '文档' },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `extra-${index}`, label: `额外桶 ${index}` }))],
    } }));
    await page.route('**/api/v1/buckets/extra-29/objects?**', route => route.fulfill({ json: { objects: [], prefixes: [], truncated: false, cursor: null } }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '文档', exact: true })).toBeVisible();
    if (width < 768) await page.getByRole('button', { name: '打开导航' }).click();
    const sidebar = page.getByLabel('存储桶选择', { exact: true });
    expect(await sidebar.evaluate(element => ({
      overflow: element.scrollHeight > element.clientHeight,
      scrollbar: getComputedStyle(element).scrollbarWidth,
      webkitScrollbar: getComputedStyle(element, '::-webkit-scrollbar').display,
    }))).toEqual({ overflow: true, scrollbar: 'none', webkitScrollbar: 'none' });
    await sidebar.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await sidebar.getByRole('button', { name: /额外桶 29 extra-29/ }).click();
    await expect(page.getByRole('heading', { name: '额外桶 29', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('listing errors are actionable and retry recovers the file list', async ({ page }) => {
  await mockFiles(page);
  let fail = true;
  await page.route('**/api/v1/buckets/documents/objects?**', async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: { message: '暂时不可用' } } });
    else await route.fallback();
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('暂时不可用');
  await expect(page.getByRole('heading', { name: '暂时无法加载文件' })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('button', { name: 'alpha.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('regular download is the default and multipart download falls back to commands', async ({ page }) => {
  await mockFiles(page);
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); });
  await page.goto('/');
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'alpha.txt', exact: true }) });
  const regular = row.getByRole('link', { name: '下载', exact: true });
  await expect(regular).toHaveAttribute('href', /object\?key=alpha\.txt/);
  await page.route('**/api/v1/buckets/documents/object?key=alpha.txt', route => route.fulfill({
    body: 'regular download', headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="alpha.txt"' },
  }));
  const downloaded = page.waitForEvent('download');
  await regular.click();
  expect((await downloaded).suggestedFilename()).toBe('alpha.txt');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '传输任务' })).toContainText('暂无传输任务');
  await row.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  const details = page.getByRole('dialog', { name: '文件详情' });
  const fromDetails = details.getByRole('link', { name: '下载', exact: true });
  await expect(fromDetails).toHaveAttribute('href', /object\?key=alpha\.txt/);
  const downloadedFromDetails = page.waitForEvent('download');
  await fromDetails.click();
  expect((await downloadedFromDetails).suggestedFilename()).toBe('alpha.txt');
  await details.getByRole('button', { name: '下载命令' }).click();
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '命令行下载' }).getByRole('textbox', { name: '下载命令' })).toHaveValue(/aria2c.*alpha\.txt/);
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  await details.getByRole('button', { name: '分片下载' }).click();
  await expect(details).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '命令行下载' })).toContainText('此浏览器不支持分片落盘');
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: 'alpha.txt 更多操作' }).click();
  await page.getByRole('menuitem', { name: '分片下载', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '命令行下载' })).toContainText('此浏览器不支持分片落盘');
  await page.keyboard.press('Escape');
  await expect(regular).toBeVisible();
});

test('download picker runs in a user gesture and tasks pause/resume with ordered disk writes', async ({ page }) => {
  await mockFiles(page);
  const total = 20 * 1024 * 1024;
  await page.addInitScript(() => {
    const target = window as typeof window & { disk: { active: boolean; writes: { position: number; length: number }[]; closed: boolean; aborted: boolean } };
    target.disk = { active: false, writes: [], closed: false, aborted: false };
    Object.defineProperty(window, 'showSaveFilePicker', { value: async () => {
      target.disk.active = navigator.userActivation.isActive;
      return { createWritable: async () => ({
        write: async ({ position, data }: { position: number; data: Uint8Array }) => { target.disk.writes.push({ position, length: data.length }); },
        close: async () => { target.disk.closed = true; }, abort: async () => { target.disk.aborted = true; },
      }) };
    } });
  });
  await page.route('**/api/v1/buckets/documents/metadata?key=alpha.txt', route => route.fulfill({ json: info('alpha.txt', total) }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route('**/api/v1/buckets/documents/object?key=alpha.txt', async route => {
    const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers()['range'])!;
    const start = Number(range[1]), end = Number(range[2]);
    requests++;
    if (start === 0) await gate;
    await route.fulfill({ status: 206, body: Buffer.alloc(end - start + 1, 42), headers: {
      'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': String(end - start + 1), etag: '"fixed-etag"',
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '传输设置', exact: true }).click();
  const partSize = page.getByRole('slider', { name: '分片大小', exact: true });
  await expect(partSize).toHaveAttribute('aria-valuetext', '16 MiB');
  await partSize.press('End');
  await expect(partSize).toHaveAttribute('aria-valuetext', '64 MiB');
  await partSize.press('ArrowLeft');
  await expect(partSize).toHaveAttribute('aria-valuetext', '32 MiB');
  await partSize.press('Home');
  await expect(partSize).toHaveAttribute('aria-valuetext', '8 MiB');
  const concurrency = page.getByRole('slider', { name: '下载并发', exact: true });
  await expect(concurrency).toHaveAttribute('aria-valuenow', '4');
  await concurrency.press('End');
  await expect(concurrency).toHaveAttribute('aria-valuenow', '6');
  await concurrency.press('ArrowLeft');
  await expect(concurrency).toHaveAttribute('aria-valuenow', '4');
  await concurrency.press('Home');
  await expect(concurrency).toHaveAttribute('aria-valuetext', '1 路');
  await page.getByRole('dialog', { name: '传输设置', exact: true }).getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('button', { name: '传输设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '传输设置', exact: true }).click();
  await expect(partSize).toHaveAttribute('aria-valuetext', '8 MiB');
  await expect(concurrency).toHaveAttribute('aria-valuetext', '1 路');
  await page.getByRole('button', { name: '关闭设置弹窗' }).click();
  await expect(page.getByRole('dialog', { name: '传输设置', exact: true })).not.toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'alpha.txt', exact: true }) });
  await row.getByRole('button', { name: 'alpha.txt', exact: true }).click();
  await page.getByRole('dialog', { name: '文件详情' }).getByRole('button', { name: '分片下载' }).click();
  await expect(page.getByRole('dialog', { name: '文件详情' })).not.toBeVisible();
  const tasks = page.getByRole('region', { name: '传输任务' });
  await expect.poll(() => requests).toBe(1);
  await tasks.getByRole('button', { name: '暂停', exact: true }).click();
  release();
  await expect(tasks.getByText('已暂停', { exact: true })).toBeVisible();
  await expect(tasks.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  expect(requests).toBe(1);
  await tasks.getByRole('button', { name: '继续', exact: true }).click();
  await expect(tasks.getByText('已完成', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { disk: unknown }).disk)).toEqual({
    active: true, closed: true, aborted: false,
    writes: [{ position: 0, length: 8 * 1024 * 1024 }, { position: 8 * 1024 * 1024, length: 8 * 1024 * 1024 }, { position: 16 * 1024 * 1024, length: 4 * 1024 * 1024 }],
  });
});
