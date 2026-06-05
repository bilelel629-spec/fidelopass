/// <reference types="astro/client" />

declare module 'qrcode' {
  export function toDataURL(
    text: string,
    options?: {
      width?: number;
      margin?: number;
      color?: {
        dark?: string;
        light?: string;
      };
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    },
  ): Promise<string>;

  export function toString(
    text: string,
    options?: {
      type?: 'svg' | 'utf8' | 'terminal';
      width?: number;
      margin?: number;
      color?: {
        dark?: string;
        light?: string;
      };
      errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    },
  ): Promise<string>;

  const QRCode: {
    toDataURL: typeof toDataURL;
    toString: typeof toString;
  };
  export default QRCode;
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly PUBLIC_API_URL?: string;
  readonly PUBLIC_SITE_URL?: string;
  readonly PUBLIC_WEB_PUSH_VAPID_KEY?: string;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  readonly WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  readonly WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  readonly WEB_PUSH_SUBJECT?: string;
  readonly ADMIN_EMAILS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

declare module 'canvas-confetti';
