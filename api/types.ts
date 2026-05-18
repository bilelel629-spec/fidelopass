import type { User } from '@supabase/supabase-js';

export type ApiEnv = {
  Variables: {
    user: User;
    userId: string;
  };
};
