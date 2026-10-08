import { Badge, Button, Group, Paper, Progress, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { ArrowDownToLine, ArrowUpFromLine, ListChecks, Pause, Play, RotateCcw, X } from 'lucide-react';
import { sizeText } from '../api';
import { type Transfer, type State } from '../transfers';
import classes from '../App.module.css';

export interface TaskEntry { task: Transfer; bucket: string; bucketLabel: string }
const labels: Record<State, string> = { running: '传输中', paused: '已暂停', error: '失败', complete: '已完成', cancelled: '已取消' };
const colors: Record<State, string> = { running: 'blue', paused: 'orange', error: 'red', complete: 'teal', cancelled: 'gray' };

export function TransfersPanel({ entries, clear }: { entries: TaskEntry[]; clear: () => void }) {
  const active = entries.filter(({ task }) => !['complete', 'cancelled'].includes(task.state)).length;
  return <Paper component="section" withBorder radius="lg" className={classes.panel} aria-label="传输任务">
    <Group justify="space-between" className={classes.panelHeader}>
      <Group gap="sm"><ListChecks size={19} aria-hidden /><Title order={2} size="h5">传输任务</Title>
        <Badge variant="light" color={active ? 'blue' : 'gray'}>{active} 个未结束</Badge></Group>
      <Button variant="subtle" color="gray" size="xs" disabled={!entries.some(({ task }) => ['complete', 'cancelled'].includes(task.state))} onClick={clear}>清除已结束</Button>
    </Group>
    {!entries.length ? <div className={classes.transferEmpty}>
      <Text size="sm" c="dimmed">暂无传输任务</Text><Text size="xs" c="dimmed">上传文件或开始分片下载后，可在这里查看进度。</Text>
    </div> : <Stack gap={0}>{entries.map(({ task, bucketLabel }) => {
      const percent = task.state === 'complete' ? 100 : task.total ? Math.min(100, task.done / task.total * 100) : 0;
      const elapsed = Math.max(((task.finishedAt ?? Date.now()) - task.started) / 1000, 1);
      const Icon = task.kind === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
      return <div className={classes.task} key={task.id}>
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon variant="light" color={task.kind === 'upload' ? 'violet' : 'blue'} radius="md" size={36}><Icon size={18} /></ThemeIcon>
          <div className={classes.taskContent}>
            <Group justify="space-between" gap="xs"><Text size="sm" fw={600} className={classes.breakWord}>{task.name}</Text><Badge color={colors[task.state]} variant="light">{labels[task.state]}</Badge></Group>
            <Text size="xs" c="dimmed" mt={3}>{bucketLabel} · {task.kind === 'upload' ? '上传' : '下载'}</Text>
            <Progress value={percent} color={colors[task.state]} size="sm" radius="xl" mt="sm" aria-label={`${task.name} 传输进度`} />
            <Group justify="space-between" mt="xs" gap="xs">
              <Text size="xs" c="dimmed">{sizeText(task.done)} / {sizeText(task.total)} · {percent.toFixed(0)}% · 平均 {sizeText(task.done / elapsed)}/s</Text>
              <Group gap={4}>
                {task.state === 'running' && <Button variant="subtle" size="compact-xs" leftSection={<Pause size={13} />} onClick={() => task.pause()}>暂停</Button>}
                {['paused', 'error'].includes(task.state) && <Button variant="light" size="compact-xs" leftSection={task.state === 'error' ? <RotateCcw size={13} /> : <Play size={13} />} onClick={() => task.resume()}>{task.state === 'error' ? '重试' : '继续'}</Button>}
                {!['complete', 'cancelled'].includes(task.state) && <Button variant="subtle" color="gray" size="compact-xs" leftSection={<X size={13} />} onClick={() => void task.cancel()}>取消</Button>}
              </Group>
            </Group>
            {task.error && <Text size="xs" c="red" mt="xs" className={classes.breakWord} role="alert">{task.error}</Text>}
          </div>
        </Group>
      </div>;
    })}</Stack>}
  </Paper>;
}
