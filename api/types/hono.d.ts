import type { User } from '@supabase/supabase-js';
import type { BillingStatusPayload } from '../services/billing';
import type { PartnerContext } from '../middleware/partner';

declare module 'hono' {
  interface ContextVariableMap {
    user: User;
    userId: string;
    billing: BillingStatusPayload;
    partnerContext: PartnerContext;
  }
}
