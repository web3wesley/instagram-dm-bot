/** Subscribes the connected Instagram account to the webhook fields (POST /me/subscribed_apps via the bot). */
import { adminFetch } from './lib.ts';

const res = await adminFetch('/admin/subscribe', { method: 'POST', body: '{}' });
console.log(JSON.stringify(await res.json(), null, 2));
