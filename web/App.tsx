import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Alert, AppShell, Badge, Box, Burger, Button, Group, Menu, Modal, NavLink, Skeleton, Slider, Stack, Text, ThemeIcon, Title, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { AlertCircle, ArrowDownUp, BookOpen, Check, ChevronDown, Cloud, Database, HardDrive, Laptop, LogOut, Moon, Settings2, ShieldCheck, Sun, User } from 'lucide-react';
import { api, endpoint, sizeText, type BucketInfo, type ObjectInfo, type Page } from './api';
import { download, type Transfer, upload } from './transfers';
import { BrowserPanel } from './components/BrowserPanel';
import { CommandDialog, DetailsDrawer, type CommandTarget } from './components/FileDialogs';
import { useConfirmation } from './components/ConfirmDialog';
import { TransfersPanel, type TaskEntry } from './components/TransfersPanel';
import { UploadDialog, type UploadSelection } from './components/UploadDialog';
import classes from './App.module.css';

const emptyPage = (): Page => ({ objects: [], prefixes: [], truncated: false, cursor: null });
const partSizes = [8, 16, 32, 64];

export function App() {
  const [buckets, setBuckets] = useState<BucketInfo[]>([]);
  const [identity, setIdentity] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [filter, setFilter] = useState('');
  const [flat, setFlat] = useState(false);
  const [page, setPage] = useState<Page>(emptyPage);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingBuckets, setLoadingBuckets] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState<ObjectInfo | null>(null);
  const [commandTarget, setCommandTarget] = useState<CommandTarget | null>(null);
  const [uploadSelection, setUploadSelection] = useState<UploadSelection | null>(null);
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  const entriesRef = useRef(entries);
  const [, refresh] = useState(0);
  const [partMiB, setPartMiB] = useState(16);
  const [parallel, setParallel] = useState(4);
  const [mobileOpened, mobile] = useDisclosure(false);
  const [settingsOpened, settings] = useDisclosure(false);
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { confirm, dialog } = useConfirmation();
  const fileInput = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const mounted = useRef(true);
  const viewRef = useRef({ bucket, prefix, flat });
  viewRef.current = { bucket, prefix, flat };
  const bucketInfo = buckets.find(item => item.id === bucket);
  const notify = () => { if (mounted.current) refresh(value => value + 1); };

  async function loadBuckets() {
    setLoadingBuckets(true); setError('');
    try {
      const data = await api<{ buckets: BucketInfo[]; identity: string }>('/api/v1/buckets');
      if (!mounted.current) return;
      setBuckets(data.buckets); setIdentity(data.identity); setBucket(data.buckets[0]?.id ?? '');
    } catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setLoadingBuckets(false); }
  }

  useEffect(() => {
    mounted.current = true;
    void loadBuckets();
    const timer = setInterval(notify, 1000);
    return () => { mounted.current = false; loadId.current++; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      if (entriesRef.current.some(({ task }) => !['complete', 'cancelled'].includes(task.state))) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  async function load(more = false, view = viewRef.current) {
    if (!view.bucket) return;
    const id = ++loadId.current;
    setLoading(true); setError('');
    try {
      const result = await api<Page>(endpoint(view.bucket, 'objects', { prefix: view.prefix, delimiter: view.flat ? '' : '/',
        ...(more && page.cursor ? { cursor: page.cursor } : {}) }));
      if (id !== loadId.current || !mounted.current) return;
      setPage(previous => more ? { ...result, objects: [...previous.objects, ...result.objects],
        prefixes: [...new Set([...previous.prefixes, ...result.prefixes])] } : result);
      if (!more) setSelected(new Set());
    } catch (error) { if (id === loadId.current && mounted.current) setError((error as Error).message); }
    finally { if (id === loadId.current && mounted.current) setLoading(false); }
  }
  useEffect(() => {
    setPage(emptyPage()); setSelected(new Set());
    void load();
  }, [bucket, prefix, flat]);

  function start(task: Transfer, targetBucket: string) {
    const next = [...entriesRef.current, { task, bucket: targetBucket, bucketLabel: buckets.find(item => item.id === targetBucket)?.label ?? targetBucket }];
    entriesRef.current = next;
    setEntries(next);
    void task.execute().then(() => {
      // Only successful uploads change the listing; load the view visible at completion.
      if (mounted.current && task.kind === 'upload' && task.state === 'complete' && viewRef.current.bucket === targetBucket) void load();
    });
  }

  async function startDownload(info: ObjectInfo) {
    const targetBucket = bucket;
    if (!window.showSaveFilePicker) {
      setCommandTarget({ bucket: targetBucket, key: info.key, kind: 'aria2', fallback: true });
      return;
    }
    try {
      // Keep the picker directly in the click handler, before any network await.
      const handle = await window.showSaveFilePicker({ suggestedName: info.key.split('/').pop() || 'download' });
      const latest = await api<ObjectInfo>(endpoint(targetBucket, 'metadata', { key: info.key }));
      start(download(targetBucket, latest, handle, partMiB * 1024 * 1024, parallel, notify), targetBucket);
    } catch (error) { if ((error as Error).name !== 'AbortError') setError((error as Error).message); }
  }

  function setOperationBusy(value: boolean) { busyRef.current = value; setBusy(value); }

  function selectFiles(files: FileList | null) {
    if (!files?.length || busyRef.current || !bucket) return;
    setOperationBusy(true);
    setUploadSelection({ bucket, bucketLabel: bucketInfo?.label ?? bucket, prefix, files: Array.from(files) });
    if (fileInput.current) fileInput.current.value = '';
  }

  function closeUpload() { setUploadSelection(null); setOperationBusy(false); }

  async function addFiles(selection: UploadSelection, targetPrefix: string) {
    setUploadSelection(null);
    setOperationBusy(true); setError('');
    const targetBucket = selection.bucket;
    const partSize = partMiB * 1024 * 1024;
    try {
      for (const file of selection.files) {
        const key = targetPrefix + file.name;
        if (Math.ceil(file.size / partSize) > 10000) throw new Error(`${file.name} 分片数超出 10,000，请提高分片大小`);
        if (entriesRef.current.some(entry => entry.bucket === targetBucket && entry.task.kind === 'upload' && entry.task.name === key && !['complete', 'cancelled'].includes(entry.task.state))) {
          throw new Error(`已有同名上传任务：${key}`);
        }
        let existing = false;
        try { await api(endpoint(targetBucket, 'metadata', { key })); existing = true; }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        if (existing && !await confirm({ title: '覆盖已有文件？', description: `存储桶：${selection.bucketLabel}。已有文件会被替换，此操作无法撤销。`, keys: [key], confirmLabel: '确认覆盖' })) continue;
        if (!mounted.current) return;
        start(upload(targetBucket, key, file, partSize, notify, () => {
          if (mounted.current) notifications.show({ title: '上传完成', message: key, color: 'teal' });
        }), targetBucket);
      }
    } catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setOperationBusy(false); }
  }

  async function remove(keys: string[]) {
    if (!keys.length || busyRef.current) return;
    setOperationBusy(true);
    const targetBucket = bucket;
    try {
      if (!await confirm({ title: `删除 ${keys.length} 个文件？`, description: `存储桶：${bucketInfo?.label ?? targetBucket}。文件将被永久删除，此操作无法撤销。`, keys, confirmLabel: '永久删除' }) || !mounted.current) return;
      setError('');
      const failed: string[] = [];
      for (const key of keys) {
        try { await api(endpoint(targetBucket, 'object', { key }), { method: 'DELETE' }); }
        catch (error) { failed.push(`${key}: ${(error as Error).message}`); }
      }
      if (!mounted.current) return;
      await load();
      if (failed.length) setError(`删除失败：${failed.join('；')}`);
      else notifications.show({ title: '删除完成', message: `已删除 ${keys.length} 个文件`, color: 'teal' });
    } finally { if (mounted.current) setOperationBusy(false); }
  }

  function navigate(value: string) {
    if (busyRef.current) return;
    loadId.current++;
    viewRef.current = { ...viewRef.current, prefix: value };
    setPrefix(value); setFilter(value); setDetails(null); setCommandTarget(null);
    // Submitting the same prefix should still refresh the list.
    if (value === prefix) void load();
  }

  function changeBucket(value: string) {
    if (busyRef.current) return;
    loadId.current++;
    viewRef.current = { bucket: value, prefix: '', flat };
    setBucket(value); setPrefix(''); setFilter(''); setDetails(null); setCommandTarget(null); mobile.close();
  }

  const activeCount = entries.filter(({ task }) => !['complete', 'cancelled'].includes(task.state)).length;
  const bytes = page.objects.reduce((sum, info) => sum + info.size, 0);
  return <AppShell header={{ height: 72 }} navbar={{ width: 256, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }} padding={0} className={classes.shell}>
    <AppShell.Header className={classes.header}>
      <Group justify="space-between" h="100%" wrap="nowrap" className={classes.headerContent}>
        <Group gap="sm" wrap="nowrap">
          <Burger opened={mobileOpened} onClick={mobile.toggle} hiddenFrom="sm" size="sm" aria-label={mobileOpened ? '关闭导航' : '打开导航'} />
          <ThemeIcon size={38} radius="lg" variant="filled" visibleFrom="sm"><Cloud size={23} /></ThemeIcon>
          <div><Text fw={700} size="md">Hoshino R2</Text><Text size="xs" c="dimmed">云端文件管理器</Text></div>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Tooltip label="OpenAPI 文档"><ActionIcon component="a" href="/api/v1/openapi.json" target="_blank" rel="noreferrer" variant="default" aria-label="OpenAPI 文档"><BookOpen size={18} /></ActionIcon></Tooltip>
          <Tooltip label="传输设置"><ActionIcon variant="default" aria-label="传输设置" onClick={() => { mobile.close(); settings.open(); }}><Settings2 size={18} /></ActionIcon></Tooltip>
          <Menu position="bottom-end">
            <Menu.Target><Tooltip label="切换主题"><ActionIcon variant="default" aria-label="切换主题"><Sun size={18} /></ActionIcon></Tooltip></Menu.Target>
            <Menu.Dropdown><Menu.Label>外观</Menu.Label>{([
              ['light', '浅色', Sun], ['dark', '深色', Moon], ['auto', '跟随系统', Laptop],
            ] as const).map(([value, label, Icon]) => <Menu.Item key={value} leftSection={<Icon size={16} />} rightSection={colorScheme === value ? <Check size={14} /> : null} onClick={() => setColorScheme(value)}>{label}</Menu.Item>)}</Menu.Dropdown>
          </Menu>
          <Menu position="bottom-end">
            <Menu.Target><Button variant="subtle" color="gray" className={classes.identityButton} leftSection={<User size={16} />} rightSection={<ChevronDown size={13} />} aria-label="账户菜单"><span className={classes.identityText}>{identity || '正在连接…'}</span></Button></Menu.Target>
            <Menu.Dropdown><Menu.Label className={classes.breakWord}>{identity || '正在连接…'}</Menu.Label>
              <Menu.Label><Group gap="xs"><ShieldCheck size={15} className={classes.secureIcon} />{identity === '本地开发' ? '本地开发模式' : 'Cloudflare Access 鉴权'}</Group></Menu.Label>
              <Menu.Item component="a" href="/cdn-cgi/access/logout" leftSection={<LogOut size={16} />}>退出登录</Menu.Item></Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
    </AppShell.Header>
    <AppShell.Navbar p="md" className={classes.sidebar} aria-label="存储桶选择">
      <AppShell.Section>
        <Group justify="space-between" px="xs" mb="sm"><Text size="xs" c="dimmed" fw={600} tt="uppercase" lts={1}>存储桶</Text><Badge size="sm" color="gray" variant="light">{buckets.length}</Badge></Group>
        {loadingBuckets ? <Stack gap="xs"><Skeleton height={62} /><Skeleton height={62} /></Stack> : buckets.map(item =>
          <NavLink component="button" key={item.id} active={item.id === bucket} label={item.label} description={item.id} leftSection={<Database size={18} />} disabled={busy}
            className={classes.bucketLink} onClick={() => changeBucket(item.id)} aria-current={item.id === bucket ? 'page' : undefined} />)}
        {!loadingBuckets && !buckets.length && <Text c="dimmed" size="sm" p="xs">没有可用的存储桶</Text>}
      </AppShell.Section>
    </AppShell.Navbar>
    {mobileOpened && <UnstyledOverlay close={mobile.close} />}
    <AppShell.Main>
      <Box className={classes.content}>
        <div className={classes.pageHeading}>
          <div><Group gap="xs" mb={6}><Text size="xs" c="dimmed" fw={600} lts={1}>WORKSPACE</Text><Badge size="xs" variant="dot" color="teal">R2</Badge></Group>
            <Title order={1} size="h2">{bucketInfo?.label ?? '文件空间'}</Title>
            <Text size="sm" c="dimmed" mt={6}>浏览、管理与传输你的云端文件。</Text></div>
          <Group gap="xs"><Badge variant="light" color="gray" leftSection={<HardDrive size={13} />}>{sizeText(bytes)} 已加载</Badge>
            <Badge variant="light" leftSection={<ArrowDownUp size={13} />}>{activeCount} 个未结束任务</Badge></Group>
        </div>
        {error && <Alert title="操作未完成" color="red" icon={<AlertCircle size={18} />} withCloseButton onClose={() => setError('')} closeButtonLabel="关闭错误提示" mb="lg" classNames={{ message: classes.breakWord }}>
          {error}{!bucket && <Button variant="light" color="red" size="xs" mt="sm" onClick={() => void loadBuckets()}>重新连接</Button>}
        </Alert>}
        <BrowserPanel bucket={bucket} prefix={prefix} filter={filter} flat={flat} page={page} selected={selected} loading={loading || loadingBuckets} busy={busy} hasError={!!error}
          setFilter={setFilter} setFlat={value => { loadId.current++; viewRef.current = { ...viewRef.current, flat: value }; setFlat(value); }} navigate={navigate} select={setSelected} load={more => void load(more)}
          upload={() => fileInput.current?.click()} details={setDetails} download={info => void startDownload(info)}
          command={(info, kind) => setCommandTarget({ bucket, key: info.key, kind })} remove={keys => void remove(keys)} />
        <input ref={fileInput} type="file" multiple hidden aria-label="选择上传文件" onChange={event => selectFiles(event.currentTarget.files)} />
        <TransfersPanel entries={entries} clear={() => {
          const next = entriesRef.current.filter(({ task }) => !['complete', 'cancelled'].includes(task.state)); entriesRef.current = next; setEntries(next);
        }} />
        <Text component="footer" size="xs" c="dimmed" ta="center" py="lg">网页与命令行共用 API · 多桶统一管理 · 大文件分片传输</Text>
      </Box>
    </AppShell.Main>
    <Modal opened={settingsOpened} onClose={settings.close} title="传输设置" centered size="md" closeButtonProps={{ 'aria-label': '关闭设置弹窗' }}>
      <Stack gap="md">
        <div>
          <Group justify="space-between" mb="xs"><Text size="sm" fw={500}>分片大小</Text><Badge variant="light" size="sm">{partMiB} MiB</Badge></Group>
          <Slider value={partSizes.indexOf(partMiB)} onChange={value => setPartMiB(partSizes[value])} min={0} max={3} restrictToMarks thumbSize={18}
            marks={partSizes.map((size, value) => ({ value, label: String(size) }))}
            thumbLabel="分片大小" thumbValueText={value => `${partSizes[value]} MiB`} label={value => `${partSizes[value]} MiB`}
            className={classes.settingSlider} />
        </div>
        <div>
          <Group justify="space-between" mb="xs"><Text size="sm" fw={500}>并发</Text><Badge variant="light" size="sm">{parallel} 路</Badge></Group>
          <Slider value={parallel} onChange={setParallel} min={1} max={6} restrictToMarks thumbSize={18}
            marks={[1, 2, 4, 6].map(value => ({ value, label: String(value) }))}
            thumbLabel="下载并发" thumbValueText={value => `${value} 路`} label={value => `${value} 路`}
            className={classes.settingSlider} />
        </div>
        <Text size="xs" c="dimmed">上传固定 3 路并发。新设置应用于新任务。暂停会等待当前分片结束；网页任务仅保留在当前页面。</Text>
        <Group justify="flex-end"><Button onClick={settings.close}>完成</Button></Group>
      </Stack>
    </Modal>
    <DetailsDrawer info={details} bucket={bucket} onClose={() => setDetails(null)}
      onDownload={info => void startDownload(info)} onCommand={info => setCommandTarget({ bucket, key: info.key, kind: 'aria2' })} />
    <CommandDialog target={commandTarget} onClose={() => setCommandTarget(null)} />
    {uploadSelection && <UploadDialog selection={uploadSelection} onClose={closeUpload} onUpload={value => void addFiles(uploadSelection, value)} />}
    {dialog}
  </AppShell>;
}

function UnstyledOverlay({ close }: { close: () => void }) {
  return <button type="button" className={classes.mobileOverlay} aria-label="关闭导航遮罩" onClick={close} />;
}
