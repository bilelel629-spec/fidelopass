import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

export const authRoutes = new Hono();

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const loginSchema = z.object({
  email: z.string().email('Email invalide'),
  password: z.string().min(8, 'Mot de passe trop court'),
});

const registerRequestSchema = z.object({
  email: z.string().email('Email invalide'),
  password: z.string().min(8, 'Mot de passe trop court'),
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findUserByEmail(email: string) {
  let page = 1;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });

    if (error) throw error;

    const existingUser = data.users.find((user) => user.email?.toLowerCase() === email);
    if (existingUser) return existingUser;
    if (data.users.length < 1000) return null;

    page += 1;
  }
}

async function requestRegistrationCode(email: string, password: string) {
  return supabase.auth.signUp({
    email,
    password,
  });
}

async function resendRegistrationCode(email: string) {
  return supabase.auth.resend({
    type: 'signup',
    email,
  });
}

async function updatePendingRegistrationPassword(userId: string, password: string) {
  return supabaseAdmin.auth.admin.updateUserById(userId, { password });
}

async function handleRegisterRequest(body: unknown) {
  const parsed = registerRequestSchema.safeParse(body);

  if (!parsed.success) {
    return { status: 400, payload: { error: parsed.error.errors[0]?.message ?? 'Données invalides' } };
  }

  const email = normalizeEmail(parsed.data.email);
  const password = parsed.data.password;

  try {
    const existingUser = await findUserByEmail(email);

    if (existingUser?.email_confirmed_at) {
      return {
        status: 409,
        payload: {
          error: 'Cette adresse email est déjà confirmée. Connectez-vous pour continuer.',
          code: 'EMAIL_ALREADY_CONFIRMED',
        },
      };
    }

    if (existingUser) {
      const { error: updateError } = await updatePendingRegistrationPassword(existingUser.id, password);
      if (updateError) {
        return {
          status: 400,
          payload: { error: updateError.message ?? 'Impossible de mettre a jour le mot de passe temporaire.' },
        };
      }
    }

    const { data, error } = existingUser
      ? await resendRegistrationCode(email)
      : await requestRegistrationCode(email, password);

    if (error) {
      return {
        status: 400,
        payload: { error: error.message ?? 'Impossible d\'envoyer le code de vérification.' },
      };
    }

    return {
      status: 200,
      payload: {
        requires_email_verification: existingUser ? true : !data.session && !data.user?.email_confirmed_at,
        message: existingUser
          ? 'Nouveau code envoyé. Vérifiez votre boîte mail.'
          : (!data.session && !data.user?.email_confirmed_at
            ? 'Code envoyé. Vérifiez votre boîte mail.'
            : 'Compte créé. Connexion en cours.'),
      },
    };
  } catch (error) {
    console.error('[auth register request]', error);
    return {
      status: 500,
      payload: { error: 'Erreur lors de la préparation de l\'inscription.' },
    };
  }
}

authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.errors[0]?.message ?? 'Données invalides' }, 400);
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(parsed.data.email),
    password: parsed.data.password,
  });

  if (error) return c.json({ error: error.message ?? 'Email ou mot de passe incorrect' }, 401);

  return c.json({ session: data.session, user: data.user });
});

authRoutes.post('/register/request-code', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await handleRegisterRequest(body);
  return c.json(result.payload, result.status as 200 | 400 | 403 | 409 | 500);
});

authRoutes.post('/register/resend-code', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await handleRegisterRequest(body);
  return c.json(result.payload, result.status as 200 | 400 | 403 | 409 | 500);
});

authRoutes.post('/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await handleRegisterRequest(body);
  return c.json(result.payload, result.status as 200 | 400 | 403 | 409 | 500);
});

authRoutes.post('/logout', async (c) => {
  await supabase.auth.signOut();
  return c.json({ ok: true });
});
