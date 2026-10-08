import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { AlertTriangle } from 'lucide-react';
import classes from '../App.module.css';

interface Confirmation { title: string; description: string; keys: string[]; confirmLabel: string }

export function useConfirmation() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolve = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => { resolve.current?.(false); }, []);

  function settle(accepted: boolean) {
    const done = resolve.current;
    resolve.current = null;
    setRequest(null);
    done?.(accepted);
  }

  function confirm(value: Confirmation) {
    resolve.current?.(false);
    setRequest(value);
    return new Promise<boolean>(done => { resolve.current = done; });
  }

  const dialog = <Modal opened={!!request} onClose={() => settle(false)} title={request?.title}
    centered size="md" closeButtonProps={{ 'aria-label': '关闭确认弹窗' }}>
    {request && <Stack>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <AlertTriangle size={22} className={classes.warningIcon} aria-hidden />
        <Text size="sm" c="dimmed">{request.description}</Text>
      </Group>
      <ScrollArea.Autosize mah={200}>
        <Stack gap={6} className={classes.keyList}>{request.keys.map((key, index) =>
          <Text key={index} size="sm" className={classes.breakWord}>{key}</Text>)}</Stack>
      </ScrollArea.Autosize>
      <Group justify="flex-end">
        <Button variant="default" data-autofocus onClick={() => settle(false)}>取消</Button>
        <Button color="red" onClick={() => settle(true)}>{request.confirmLabel}</Button>
      </Group>
    </Stack>}
  </Modal>;
  return { confirm, dialog };
}
