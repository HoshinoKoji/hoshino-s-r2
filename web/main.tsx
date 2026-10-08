import { createRoot } from 'react-dom/client';
import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { setNonce } from 'get-nonce';
import { App } from './App';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './style.css';

const theme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif',
  headings: { fontFamily: 'inherit', fontWeight: '650' },
  components: {
    Button: { defaultProps: { size: 'sm' } },
    ActionIcon: { defaultProps: { size: 'lg', variant: 'subtle' } },
    Tooltip: { defaultProps: { withArrow: true } },
  },
});
const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')?.content;
// Mantine overlays use react-remove-scroll, which has its own nonce accessor.
if (styleNonce) setNonce(styleNonce);

createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto" getStyleNonce={() => styleNonce ?? ''}>
    <Notifications position="bottom-right" limit={3} />
    <App />
  </MantineProvider>,
);
