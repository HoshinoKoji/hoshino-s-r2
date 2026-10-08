import { ActionIcon, Anchor, Badge, Breadcrumbs, Button, Checkbox, Group, Menu, Paper, Skeleton, Stack, Switch, Table, Text, TextInput, ThemeIcon, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { ChevronRight, Download, File, FileArchive, FileCode, FileImage, FileText, Folder, FolderOpen, Home, Info, MoreHorizontal, RefreshCw, Search, Terminal, Trash2, Upload } from 'lucide-react';
import { endpoint, sizeText, type ObjectInfo, type Page } from '../api';
import classes from '../App.module.css';

interface Props {
  bucket: string; prefix: string; filter: string; flat: boolean; page: Page; selected: Set<string>;
  loading: boolean; busy: boolean; hasError: boolean;
  setFilter: (value: string) => void; setFlat: (value: boolean) => void; navigate: (value: string) => void;
  select: (keys: Set<string>) => void; load: (more?: boolean) => void; upload: () => void;
  details: (info: ObjectInfo) => void; download: (info: ObjectInfo) => void;
  command: (info: ObjectInfo, kind: 'aria2' | 'curl') => void; remove: (keys: string[]) => void;
}

function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name)) return FileImage;
  if (/\.(zip|gz|tar|7z|rar)$/i.test(name)) return FileArchive;
  if (/\.(json|js|ts|tsx|html|css|xml|toml|ya?ml)$/i.test(name)) return FileCode;
  if (/\.(txt|md|pdf|docx?)$/i.test(name)) return FileText;
  return File;
}

export function BrowserPanel(props: Props) {
  const { bucket, prefix, filter, flat, page, selected, loading, busy } = props;
  const crumbs = prefix.split('/').filter(Boolean);
  const all = page.objects.length > 0 && page.objects.every(info => selected.has(info.key));
  const some = page.objects.some(info => selected.has(info.key));
  return <Paper component="section" withBorder radius="lg" className={classes.panel} aria-label="文件浏览">
    <div className={classes.browserToolbar}>
      <Breadcrumbs separator={<ChevronRight size={13} />} classNames={{ root: classes.breadcrumbs }}>
        <Anchor component="button" size="sm" onClick={() => props.navigate('')} disabled={busy}><Group gap={6} wrap="nowrap"><Home size={15} />根目录</Group></Anchor>
        {crumbs.map((part, index) => <Anchor component="button" key={index} size="sm" disabled={busy}
          onClick={() => props.navigate(crumbs.slice(0, index + 1).join('/') + '/')}>{part}</Anchor>)}
      </Breadcrumbs>
      <Group gap="xs" wrap="nowrap">
        <Tooltip label="刷新列表"><ActionIcon variant="default" aria-label="刷新" loading={loading} disabled={!bucket || busy} onClick={() => props.load()}><RefreshCw size={17} /></ActionIcon></Tooltip>
        <Button leftSection={<Upload size={16} />} disabled={!bucket || busy} onClick={props.upload}>上传文件</Button>
      </Group>
    </div>
    <form className={classes.filterForm} onSubmit={event => { event.preventDefault(); props.navigate(filter); }}>
      <TextInput aria-label="对象前缀" placeholder="按前缀筛选，例如 backups/2026/" leftSection={<Search size={16} />}
        value={filter} onChange={event => props.setFilter(event.currentTarget.value)} className={classes.filterInput} disabled={!bucket || busy} />
      <Button variant="default" type="submit" disabled={!bucket || busy}>筛选</Button>
      <Switch label="递归列举" checked={flat} onChange={event => props.setFlat(event.currentTarget.checked)} disabled={!bucket || busy} />
    </form>
    {selected.size > 0 && <Group className={classes.selectionBar} justify="space-between">
      <Group gap="sm"><Badge variant="filled">{selected.size}</Badge><Text size="sm">个文件已选择</Text><Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => props.select(new Set())}>取消选择</Button></Group>
      <Button color="red" variant="light" size="xs" leftSection={<Trash2 size={14} />} disabled={busy} onClick={() => props.remove([...selected])}>删除所选</Button>
    </Group>}
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover className={classes.fileTable} aria-label="文件列表" aria-busy={loading}>
        <Table.Thead><Table.Tr>
          <Table.Th w={54}><Checkbox aria-label="全选已加载文件" checked={all} indeterminate={some && !all} disabled={!page.objects.length || loading || busy}
            onChange={event => props.select(event.currentTarget.checked ? new Set(page.objects.map(info => info.key)) : new Set())} /></Table.Th>
          <Table.Th>名称</Table.Th><Table.Th w={110}>大小</Table.Th><Table.Th w={175}>上传时间</Table.Th><Table.Th w={190}>操作</Table.Th>
        </Table.Tr></Table.Thead>
        <Table.Tbody>
          {loading && !page.objects.length && !page.prefixes.length ? Array.from({ length: 5 }, (_, index) => <Table.Tr key={index}>
            <Table.Td><Skeleton height={18} width={18} /></Table.Td><Table.Td><Skeleton height={17} width="65%" /></Table.Td>
            <Table.Td><Skeleton height={17} width={60} /></Table.Td><Table.Td><Skeleton height={17} width={120} /></Table.Td><Table.Td><Skeleton height={24} width={100} /></Table.Td>
          </Table.Tr>) : <>
            {page.prefixes.map(dir => <Table.Tr key={`dir:${dir}`}>
              <Table.Td><Folder size={19} className={classes.folderIcon} aria-hidden /></Table.Td>
              <Table.Td><UnstyledButton className={classes.fileName} disabled={busy} onClick={() => props.navigate(dir)}>{dir.slice(prefix.length) || dir}</UnstyledButton></Table.Td>
              <Table.Td><Text size="xs" c="dimmed">目录</Text></Table.Td><Table.Td><Text c="dimmed">—</Text></Table.Td>
              <Table.Td><Button variant="subtle" size="compact-sm" rightSection={<ChevronRight size={14} />} disabled={busy} onClick={() => props.navigate(dir)}>打开</Button></Table.Td>
            </Table.Tr>)}
            {page.objects.map(info => {
              const Icon = fileIcon(info.key);
              return <Table.Tr key={info.key} data-selected={selected.has(info.key) || undefined}>
                <Table.Td><Checkbox aria-label={`选择 ${info.key}`} checked={selected.has(info.key)} disabled={busy || loading} onChange={event => {
                  const next = new Set(selected); if (event.currentTarget.checked) next.add(info.key); else next.delete(info.key); props.select(next);
                }} /></Table.Td>
                <Table.Td><Group gap="sm" wrap="nowrap"><Icon size={19} className={classes.fileIcon} aria-hidden />
                  <UnstyledButton className={classes.fileName} onClick={() => props.details(info)}>{info.key.slice(prefix.length) || info.key}</UnstyledButton></Group></Table.Td>
                <Table.Td><Text size="sm" className={classes.nowrap}>{sizeText(info.size)}</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed" className={classes.nowrap}>{new Date(info.uploaded).toLocaleString()}</Text></Table.Td>
                <Table.Td><Group gap={6} wrap="nowrap">
                  <Button component="a" href={endpoint(bucket, 'object', { key: info.key })} variant="light" size="compact-xs"
                    className={classes.downloadButton} leftSection={<Download size={13} />}>下载</Button>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><ActionIcon color="gray" aria-label={`${info.key} 更多操作`}><MoreHorizontal size={18} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Label>文件操作</Menu.Label>
                      <Menu.Item leftSection={<Info size={15} />} onClick={() => props.details(info)}>文件详情</Menu.Item>
                      <Menu.Item leftSection={<Download size={15} />} onClick={() => props.download(info)}>分片下载</Menu.Item>
                      <Menu.Item leftSection={<Terminal size={15} />} onClick={() => props.command(info, 'aria2')}>aria2 命令</Menu.Item>
                      <Menu.Item leftSection={<Terminal size={15} />} onClick={() => props.command(info, 'curl')}>curl 命令</Menu.Item>
                      <Menu.Divider /><Menu.Item color="red" disabled={busy} leftSection={<Trash2 size={15} />} onClick={() => props.remove([info.key])}>删除文件</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group></Table.Td>
              </Table.Tr>;
            })}
          </>}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
    {!loading && !page.objects.length && !page.prefixes.length && <Stack align="center" gap="xs" className={classes.emptyState}>
      <ThemeIcon size={64} radius="xl" variant="light" color="gray"><FolderOpen size={30} /></ThemeIcon>
      <Title order={3} size="h5">{props.hasError ? '暂时无法加载文件' : !bucket ? '暂无可用存储桶' : '当前前缀下没有文件'}</Title>
      <Text size="sm" c="dimmed" ta="center">{props.hasError ? '请检查上方错误提示，然后重试。' : !bucket ? '请检查部署配置中的存储桶设置。' : prefix ? '试试其他前缀，或上传文件到当前位置。' : '上传第一个文件，开始管理你的云端存储。'}</Text>
      {bucket && <Button mt="xs" variant="light" leftSection={props.hasError ? <RefreshCw size={16} /> : <Upload size={16} />} disabled={busy}
        onClick={() => props.hasError ? props.load() : props.upload()}>{props.hasError ? '重新加载' : '上传文件'}</Button>}
    </Stack>}
    <Group justify="space-between" className={classes.tableFooter}>
      <Text size="xs" c="dimmed">已加载 {page.objects.length} 个文件 · {page.prefixes.length} 个目录{loading ? ' · 正在读取…' : ''}</Text>
      {page.truncated && <Button variant="default" size="xs" loading={loading} disabled={busy} onClick={() => props.load(true)}>加载更多</Button>}
    </Group>
  </Paper>;
}
