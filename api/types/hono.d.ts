import type { User } from '@supabase/supabase-js';
import type { BillingStatusPayload } from '../services/billing';

declare module 'hono' {
  interface ContextVariableMap {
    user: User;
    userId: string;
    billing: BillingStatusPayload;
  }
}
