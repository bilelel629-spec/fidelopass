import { Hono } from 'hono';
import { createServiceClient } from '../../src/lib/supabase';
import { sendSMS } from '../../src/lib/brevo-sms';

export const cronRoutes = new Hono();

/** GET /api/cron/send-scheduled-sms
 * Déclenché toutes les 5 minutes par Railway cron.
 * Header requis : Authorization: Bearer CRON_SECRET
 */
cronRoutes.get('/send-scheduled-sms', async (c) => {
  const expectedSecret = process.env.CRON_SECRET;
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '').trim();

  if (!expectedSecret || token !== expectedSecret) {
    return c.json({ error: 'Non autorisé' }, 401);
  }

  const db = createServiceClient();
  const now = new Date().toISOString();

  const { data: pending, error } = await db
    .from('sms_scheduled')
    .select('*')
    .eq('sent', false)
    .lte('send_at', now)
    .limit(50); // Sécurité : max 50 par run

  if (error) {
    console.error('[cron] Erreur lecture sms_scheduled:', error.message);
    return c.json({ error: 'Erreur base de données' }, 500);
  }

  if (!pending || pending.length === 0) {
    return c.json({ sent: 0, message: 'Aucun SMS planifié en attente' });
  }

  let sent = 0;
  let failed = 0;

  for (const sms of pending) {
    const result = await sendSMS(
      sms.telephone,
      sms.message,
      sms.commerce_id,
      sms.client_id,
      sms.type,
    );

    // Marquer comme traité même si échec (évite les boucles infinies)
    await db.from('sms_scheduled').update({ sent: true }).eq('id', sms.id);

    if (result.success) {
      sent++;
    } else {
      failed++;
      console.error(`[cron] SMS ${sms.id} échoué:`, result.error);
    }
  }

  console.log(`[cron] send-scheduled-sms: ${sent} envoyés, ${failed} échecs`);
  return c.json({ sent, failed, total: pending.length });
});
