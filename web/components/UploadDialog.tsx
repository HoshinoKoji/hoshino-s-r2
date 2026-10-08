import { useState } from 'react';
import { Button, Group, Modal, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { sizeText } from '../api';
import classes from '../App.module.css';

export interface UploadSelection { bucket: string; bucketLabel: string; prefix: string; files: File[] }

export function UploadDialog({ selection, onClose, onUpload }: {
  selection: UploadSelection; onClose: () => void; onUpload: (prefix: string) => void;
}) {
  const [prefix, setPrefix] = useState(selection.prefix);
  const targetPrefix = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  const keys = selection.files.map(file => targetPrefix + file.name);
  const invalidKey = keys.find(key => key.includes('\0') || new TextEncoder().encode(key).length > 1024);
  const error = invalidKey === undefined ? undefined : '最终路径不能包含 NUL，且最多为 1024 个 UTF-8 字节，请缩短前缀或文件名。';

  return <Modal opened onClose={onClose} title="上传文件" centered size="lg" closeButtonProps={{ 'aria-label': '关闭上传弹窗' }}>
    <form onSubmit={event => { event.preventDefault(); if (!error) onUpload(targetPrefix); }}>
      <Stack>
        <Text size="sm" className={classes.breakWord}>目标存储桶：{selection.bucketLabel}</Text>
        <TextInput label="目标路径前缀" placeholder="例如 backups/2026/" data-autofocus
          description="从桶根目录起算；留空上传到根目录，非空前缀末尾自动补 /。"
          value={prefix} onChange={event => setPrefix(event.currentTarget.value)} error={error} />
        <Text size="sm" fw={500}>最终存储路径 · {selection.files.length} 个文件</Text>
        <ScrollArea.Autosize mah={240}>
          <Stack gap="sm" className={classes.keyList} aria-label="上传路径预览">
            {selection.files.map((file, index) => <div key={index}>
              <Text size="sm" className={classes.breakWord}>{keys[index]}</Text>
              <Text size="xs" c="dimmed">{sizeText(file.size)}</Text>
            </div>)}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!!error}>开始上传</Button>
        </Group>
      </Stack>
    </form>
  </Modal>;
}
