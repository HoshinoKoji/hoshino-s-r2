import { useState } from 'react';
import { Alert, Button, Code, Divider, Drawer, Group, Modal, Stack, Tabs, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Copy, Download, FileText, Terminal } from 'lucide-react';
import { command, endpoint, sizeText, type ObjectInfo } from '../api';
import classes from '../App.module.css';

export interface CommandTarget { bucket: string; key: string; kind: 'aria2' | 'curl'; fallback?: boolean }

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    notifications.show({ title: '已复制', message: '内容已复制到剪贴板', color: 'teal' });
  } catch {
    notifications.show({ title: '复制失败', message: '请选中文本手动复制', color: 'orange' });
  }
}

export function DetailsDrawer({ info, bucket, onClose, onDownload, onCommand }: {
  info: ObjectInfo | null; bucket: string; onClose: () => void;
  onDownload: (info: ObjectInfo) => void; onCommand: (info: ObjectInfo) => void;
}) {
  const fields = info ? [
    ['对象 KEY', info.key], ['大小', `${sizeText(info.size)} (${info.size.toLocaleString()} B)`],
    ['上传时间', new Date(info.uploaded).toLocaleString()], ['内容类型', info.contentType || 'application/octet-stream'],
    ['ETag', info.etag],
  ] : [];
  return <Drawer opened={!!info} onClose={onClose} title="文件详情" position="right" size="md"
    closeButtonProps={{ 'aria-label': '关闭文件详情' }}>
    {info && <Stack gap="lg">
      <Group><FileText size={32} className={classes.fileIcon} aria-hidden /><Text fw={600} className={classes.breakWord}>{info?.key.split('/').pop()}</Text></Group>
      <Divider />
      <Group gap="xs">
        <Button component="a" href={endpoint(bucket, 'object', { key: info.key })} leftSection={<Download size={16} />}>下载</Button>
        <Button variant="light" leftSection={<Download size={16} />} onClick={() => { onDownload(info); onClose(); }}>分片下载</Button>
        <Button variant="default" leftSection={<Terminal size={16} />} onClick={() => { onCommand(info); onClose(); }}>下载命令</Button>
      </Group>
      <Divider />
      <dl className={classes.metadata}>{fields.map(([label, value]) => <div key={label}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}</dl>
      <Group><Button variant="light" leftSection={<Copy size={16} />} onClick={() => void copy(info!.key)}>复制 KEY</Button>
        <Button variant="default" onClick={() => void copy(info!.etag)}>复制 ETag</Button></Group>
    </Stack>}
  </Drawer>;
}

export function CommandDialog({ target, onClose }: { target: CommandTarget | null; onClose: () => void }) {
  return <Modal opened={!!target} onClose={onClose} title="命令行下载" centered size="lg"
    closeButtonProps={{ 'aria-label': '关闭命令行下载' }}>
    {target && <CommandContent key={`${target.bucket}:${target.key}:${target.kind}`} target={target} />}
  </Modal>;
}

function CommandContent({ target }: { target: CommandTarget }) {
  const [kind, setKind] = useState<'aria2' | 'curl'>(target.kind);
  const snippet = command(target.bucket, target.key, kind);
  return <Stack>
    {target.fallback && <Alert color="blue" icon={<Download size={18} />} title="此浏览器不支持分片落盘">
      请点击文件列表中的“下载”，或复制下方命令进行下载。
    </Alert>}
    <Text size="sm" c="dimmed">先设置 <Code>CF_ACCESS_CLIENT_ID</Code> 和 <Code>CF_ACCESS_CLIENT_SECRET</Code>。续传前请确认远端对象未被覆盖。</Text>
    <Tabs value={kind} onChange={value => setKind(value as 'aria2' | 'curl')}>
      <Tabs.List><Tabs.Tab value="aria2" leftSection={<Terminal size={16} />}>aria2</Tabs.Tab><Tabs.Tab value="curl">curl</Tabs.Tab></Tabs.List>
    </Tabs>
    <Textarea aria-label="下载命令" value={snippet} readOnly autosize minRows={6} maxRows={12}
      classNames={{ input: classes.codeInput }} onFocus={event => event.target.select()} />
    <Group justify="flex-end"><Button leftSection={<Copy size={16} />} onClick={() => void copy(snippet)}>复制命令</Button></Group>
    <Divider />
    <Text size="sm" c="dimmed">项目 CLI 支持按 ETag 校验的续传：</Text>
    <Code block className={classes.cliHint}>npm run cli -- download 桶ID 对象KEY 本地路径</Code>
  </Stack>;
}
