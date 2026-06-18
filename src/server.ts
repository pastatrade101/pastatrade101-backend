import app from './app';
import { env } from './config/env';
import { startScheduler } from './services/scheduler';

app.listen(env.PORT, () => {
  console.log(`Pastatrade API running at http://localhost:${env.PORT}`);
  startScheduler();
});
