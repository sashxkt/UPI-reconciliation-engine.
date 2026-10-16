import { createApp } from './app';
import { config } from './config';

createApp().listen(config.port, () => {
  console.log(`upi-reconciliation listening on http://localhost:${config.port}`);
});
