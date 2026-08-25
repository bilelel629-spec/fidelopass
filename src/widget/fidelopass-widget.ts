type JsonRecord = Record<string, unknown>;

type WidgetConfig = {
  merchant: { name: string; logo_url: string | null };
  theme: { title?: string; primary_color?: string; logo_url?: string | null };
  display_options: { show_history?: boolean; show_wallet_links?: boolean };
};

type Reward = {
  seuil: number;
  recompense: string;
  disponible: boolean;
  points_manquants: number;
};

type Program = {
  membership_id: string;
  card_name: string;
  location_name: string | null;
  type: 'points' | 'tampons';
  points: number;
  stamps: number;
  stamps_total: number;
  rewards_earned: number;
  reward_state: {
    reward_catalog: Reward[];
    available_rewards: Reward[];
    next_reward: Reward | null;
  } | null;
  history: Array<{ id: string; type: string; value: number; note: string | null; date: string }>;
  wallet: { apple_url: string; google_url: string };
};

type Account = {
  customer: { first_name: string };
  programs: Program[];
  portal_url: string | null;
};

const DEFAULT_API_URL = 'https://api.fidelopass.com';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function historyLabel(type: string, value: number): string {
  const labels: Record<string, string> = {
    ajout_points: `+${value} points`,
    retrait_points: `−${value} points`,
    ajout_tampon: `+${value} tampon${value > 1 ? 's' : ''}`,
    retrait_tampon: `−${value} tampon${value > 1 ? 's' : ''}`,
    recompense: 'Récompense utilisée',
    reset: 'Compteur renouvelé',
  };
  return labels[type] ?? 'Mise à jour fidélité';
}

class FidelopassLoyalty extends HTMLElement {
  private readonly root: ShadowRoot;
  private config: WidgetConfig | null = null;
  private account: Account | null = null;
  private phone = '';
  private challengeId = '';
  private error = '';
  private loading = false;
  private opened = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.opened = this.mode === 'inline' || this.hasAttribute('open');
    this.renderLoading();
    void this.initialize();
  }

  private get program(): string {
    return this.getAttribute('program')?.trim() ?? '';
  }

  private get apiUrl(): string {
    return (this.getAttribute('api-url')?.trim() || DEFAULT_API_URL).replace(/\/$/, '');
  }

  private get mode(): string {
    return this.getAttribute('mode') === 'inline' ? 'inline' : 'floating';
  }

  private get sessionKey(): string {
    return `fidelopass:widget:${this.program}:session`;
  }

  private get token(): string {
    try { return localStorage.getItem(this.sessionKey) ?? ''; } catch { return ''; }
  }

  private set token(value: string) {
    try {
      if (value) localStorage.setItem(this.sessionKey, value);
      else localStorage.removeItem(this.sessionKey);
    } catch { /* Le widget reste utilisable même si le stockage est bloqué. */ }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.apiUrl}/api/widget/${encodeURIComponent(this.program)}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => ({})) as { data?: T; error?: string };
    if (!response.ok) throw Object.assign(new Error(payload.error || 'Une erreur est survenue.'), { status: response.status });
    return (payload.data ?? payload) as T;
  }

  private async initialize() {
    if (!this.program) {
      this.error = 'Configuration du programme manquante.';
      this.render();
      return;
    }
    try {
      this.config = await this.request<WidgetConfig>('/config');
      if (this.token) await this.loadAccount();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Widget indisponible.';
    }
    this.render();
  }

  private async loadAccount() {
    try {
      this.account = await this.request<Account>('/me');
    } catch (error) {
      if ((error as { status?: number }).status === 401) this.token = '';
      else throw error;
    }
  }

  private primaryColor(): string {
    const color = this.config?.theme?.primary_color;
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb';
  }

  private frame(content: string): string {
    const merchant = this.config?.merchant.name ?? 'Fidelopass';
    const title = this.config?.theme.title ?? 'Mon espace fidélité';
    const logo = this.config?.theme.logo_url ?? this.config?.merchant.logo_url;
    const logoHtml = logo
      ? `<img class="fp-logo" src="${escapeHtml(logo)}" alt="" />`
      : `<span class="fp-logo-fallback">${escapeHtml(merchant.slice(0, 1).toUpperCase())}</span>`;
    return `
      ${this.mode === 'floating' ? `<button class="fp-launcher" type="button" aria-expanded="${this.opened}" aria-label="Ouvrir mon espace fidélité"><span>★</span><span>${escapeHtml(title)}</span></button>` : ''}
      <section class="fp-panel ${this.opened ? 'is-open' : ''}" aria-label="${escapeHtml(title)}">
        <header class="fp-header">
          <div class="fp-brand">${logoHtml}<div><strong>${escapeHtml(merchant)}</strong><span>${escapeHtml(title)}</span></div></div>
          ${this.mode === 'floating' ? '<button class="fp-close" type="button" aria-label="Fermer">×</button>' : ''}
        </header>
        <main class="fp-main">${content}</main>
        <footer>Propulsé par <a href="https://www.fidelopass.com" target="_blank" rel="noopener">Fidelopass</a></footer>
      </section>`;
  }

  private styles(): string {
    return `<style>
      :host{--fp-primary:${this.primaryColor()};--fp-ink:#0f172a;--fp-muted:#64748b;--fp-line:#e2e8f0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fp-ink);box-sizing:border-box}
      *{box-sizing:border-box}.fp-launcher{position:fixed;right:22px;bottom:22px;z-index:2147483000;display:flex;align-items:center;gap:10px;border:0;border-radius:999px;background:var(--fp-primary);color:#fff;padding:14px 20px;font:800 14px/1 inherit;box-shadow:0 16px 44px rgba(15,23,42,.28);cursor:pointer}.fp-launcher span:first-child{font-size:18px}
      .fp-panel{width:min(420px,calc(100vw - 24px));max-height:min(720px,calc(100vh - 100px));display:none;flex-direction:column;overflow:hidden;border:1px solid rgba(148,163,184,.35);border-radius:24px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.26);color:var(--fp-ink)}
      :host(:not([mode="inline"])) .fp-panel{position:fixed;right:22px;bottom:86px;z-index:2147483000}:host([mode="inline"]) .fp-panel{display:flex;position:relative;width:100%;max-height:none;box-shadow:0 18px 45px rgba(15,23,42,.12)}.fp-panel.is-open{display:flex}
      .fp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;border-bottom:1px solid var(--fp-line);background:linear-gradient(135deg,color-mix(in srgb,var(--fp-primary) 10%,white),#fff)}.fp-brand{display:flex;align-items:center;gap:11px;min-width:0}.fp-brand strong,.fp-brand span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fp-brand strong{font-size:14px}.fp-brand span{margin-top:2px;color:var(--fp-muted);font-size:12px}.fp-logo,.fp-logo-fallback{width:40px;height:40px;flex:0 0 auto;border-radius:12px;object-fit:contain;background:#fff;border:1px solid var(--fp-line)}.fp-logo-fallback{display:grid;place-items:center;background:var(--fp-primary);color:#fff;font-size:18px;font-weight:900}.fp-close{border:0;background:transparent;color:#475569;font-size:25px;line-height:1;cursor:pointer;padding:4px 7px;border-radius:9px}.fp-close:hover{background:#f1f5f9}
      .fp-main{padding:20px;overflow:auto;overscroll-behavior:contain}.fp-title{margin:0;font-size:24px;line-height:1.15;letter-spacing:-.03em}.fp-copy{margin:9px 0 0;color:var(--fp-muted);font-size:14px;line-height:1.55}.fp-form{display:grid;gap:13px;margin-top:20px}.fp-label{font-size:13px;font-weight:800}.fp-input{width:100%;min-height:48px;border:1px solid #cbd5e1;border-radius:13px;padding:12px 14px;font:500 16px/1.3 inherit;color:var(--fp-ink);outline:none}.fp-input:focus{border-color:var(--fp-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fp-primary) 15%,transparent)}.fp-button{min-height:48px;border:0;border-radius:13px;padding:12px 16px;background:var(--fp-primary);color:#fff;font:800 14px/1 inherit;cursor:pointer}.fp-button:disabled{opacity:.55;cursor:wait}.fp-button-secondary{background:#f1f5f9;color:#334155}.fp-link{border:0;background:none;padding:5px;color:var(--fp-primary);font:700 13px/1 inherit;cursor:pointer}.fp-error{margin:14px 0 0;border:1px solid #fecaca;border-radius:12px;background:#fef2f2;padding:11px 13px;color:#b91c1c;font-size:13px;line-height:1.45}.fp-note{margin-top:14px;color:#64748b;font-size:11px;line-height:1.5}
      .fp-welcome{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fp-welcome .fp-link{color:#64748b}.fp-program{margin-top:16px;border:1px solid var(--fp-line);border-radius:18px;overflow:hidden}.fp-program-head{padding:16px;background:#f8fafc}.fp-program-head p{margin:0}.fp-program-name{font-size:15px;font-weight:850}.fp-location{margin-top:3px!important;color:var(--fp-muted);font-size:11px}.fp-balance{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:15px}.fp-balance strong{font-size:34px;line-height:1;letter-spacing:-.04em}.fp-balance span{color:var(--fp-muted);font-size:12px;font-weight:700}.fp-progress{height:9px;margin-top:13px;overflow:hidden;border-radius:999px;background:#e2e8f0}.fp-progress i{display:block;height:100%;border-radius:inherit;background:var(--fp-primary)}
      .fp-section{padding:16px;border-top:1px solid var(--fp-line)}.fp-section h3{margin:0 0 11px;font-size:13px}.fp-rewards{display:grid;gap:9px}.fp-reward{display:grid;grid-template-columns:42px 1fr;align-items:center;gap:11px;min-height:64px;border:1px solid var(--fp-line);border-radius:14px;padding:10px;background:#fff}.fp-reward.available{border-color:color-mix(in srgb,var(--fp-primary) 35%,white);background:color-mix(in srgb,var(--fp-primary) 6%,white)}.fp-reward-badge{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#f1f5f9;color:#334155;font-size:11px;font-weight:900}.fp-reward.available .fp-reward-badge{background:var(--fp-primary);color:#fff}.fp-reward strong{display:block;font-size:13px;line-height:1.3}.fp-reward small{display:block;margin-top:4px;color:var(--fp-muted);font-size:11px}.fp-empty{margin:0;color:var(--fp-muted);font-size:13px}.fp-history{display:grid;gap:10px}.fp-history-row{display:flex;justify-content:space-between;gap:12px;font-size:12px}.fp-history-row strong{display:block;font-size:12px}.fp-history-row time{color:var(--fp-muted);font-size:10px;white-space:nowrap}.fp-wallets{display:grid;grid-template-columns:1fr 1fr;gap:9px}.fp-wallet{min-height:43px;border:1px solid #cbd5e1;border-radius:11px;background:#fff;color:#0f172a;font:800 12px/1 inherit;cursor:pointer}.fp-stamps{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:14px}.fp-stamp{aspect-ratio:1;border:2px dashed #cbd5e1;border-radius:50%;display:grid;place-items:center;color:#94a3b8;font-size:13px;font-weight:900}.fp-stamp.done{border-style:solid;border-color:var(--fp-primary);background:var(--fp-primary);color:#fff}
      footer{padding:11px 20px;border-top:1px solid var(--fp-line);text-align:center;color:#94a3b8;font-size:10px}footer a{color:inherit;font-weight:800;text-decoration:none}.fp-loading{display:grid;place-items:center;min-height:150px;color:var(--fp-muted);font-size:13px}
      @media(max-width:520px){.fp-launcher{right:12px;bottom:12px}.fp-launcher span:last-child{display:none}:host(:not([mode="inline"])) .fp-panel{right:6px;bottom:72px;width:calc(100vw - 12px);max-height:calc(100dvh - 84px);border-radius:20px}.fp-main{padding:17px}}
      @media(prefers-reduced-motion:no-preference){.fp-panel.is-open{animation:fp-in .2s ease-out}@keyframes fp-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}}
    </style>`;
  }

  private renderLoading() {
    this.root.innerHTML = `${this.styles()}${this.frame('<div class="fp-loading">Chargement de votre espace…</div>')}`;
    this.bindFrameEvents();
  }

  private loginView(): string {
    if (this.challengeId) {
      return `<h2 class="fp-title">Entrez le code reçu</h2><p class="fp-copy">Nous avons envoyé un code à 6 chiffres par SMS. Il reste valable 10 minutes.</p>
        ${this.error ? `<p class="fp-error" role="alert">${escapeHtml(this.error)}</p>` : ''}
        <form class="fp-form" id="fp-code-form"><label class="fp-label" for="fp-code">Code de sécurité</label><input class="fp-input" id="fp-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus /><button class="fp-button" ${this.loading ? 'disabled' : ''}>${this.loading ? 'Vérification…' : 'Me connecter'}</button><button class="fp-link" id="fp-back" type="button">Changer de numéro</button></form>`;
    }
    return `<h2 class="fp-title">Retrouvez votre fidélité</h2><p class="fp-copy">Consultez vos points, vos récompenses disponibles et votre historique sans quitter ce site.</p>
      ${this.error ? `<p class="fp-error" role="alert">${escapeHtml(this.error)}</p>` : ''}
      <form class="fp-form" id="fp-phone-form"><label class="fp-label" for="fp-phone">Numéro de téléphone de votre carte</label><input class="fp-input" id="fp-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="06 12 34 56 78" required value="${escapeHtml(this.phone)}" /><button class="fp-button" ${this.loading ? 'disabled' : ''}>${this.loading ? 'Envoi…' : 'Recevoir mon code par SMS'}</button></form><p class="fp-note">Aucun mot de passe à retenir. Votre numéro est utilisé uniquement pour retrouver vos cartes de fidélité.</p>`;
  }

  private programView(program: Program): string {
    const isPoints = program.type === 'points';
    const rewards = program.reward_state?.reward_catalog ?? [];
    const next = program.reward_state?.next_reward;
    const progressTarget = isPoints ? (next?.seuil ?? rewards.at(-1)?.seuil ?? 100) : program.stamps_total;
    const value = isPoints ? program.points : program.stamps;
    const progress = Math.max(0, Math.min(100, Math.round((value / Math.max(1, progressTarget)) * 100)));
    const rewardHtml = isPoints
      ? `<div class="fp-section"><h3>Récompenses</h3><div class="fp-rewards">${rewards.length > 0 ? rewards.map((reward) => `<div class="fp-reward ${reward.disponible ? 'available' : ''}"><span class="fp-reward-badge">${reward.seuil} pts</span><div><strong>${escapeHtml(reward.recompense)}</strong><small>${reward.disponible ? 'Disponible maintenant' : `Encore ${reward.points_manquants} point${reward.points_manquants > 1 ? 's' : ''}`}</small></div></div>`).join('') : '<p class="fp-empty">Les récompenses seront bientôt disponibles.</p>'}</div></div>`
      : `<div class="fp-section"><h3>Ma progression</h3><div class="fp-stamps">${Array.from({ length: Math.min(program.stamps_total, 20) }, (_, index) => `<span class="fp-stamp ${index < program.stamps ? 'done' : ''}">${index < program.stamps ? '✓' : index + 1}</span>`).join('')}</div></div>`;
    const historyHtml = this.config?.display_options.show_history !== false && program.history.length > 0
      ? `<div class="fp-section"><h3>Dernières activités</h3><div class="fp-history">${program.history.slice(0, 6).map((row) => `<div class="fp-history-row"><div><strong>${escapeHtml(historyLabel(row.type, row.value))}</strong>${row.note ? `<span>${escapeHtml(row.note)}</span>` : ''}</div><time>${escapeHtml(formatDate(row.date))}</time></div>`).join('')}</div></div>` : '';
    const walletHtml = this.config?.display_options.show_wallet_links !== false
      ? `<div class="fp-section"><h3>Ma carte Wallet</h3><div class="fp-wallets"><button class="fp-wallet" data-wallet="apple" data-id="${escapeHtml(program.membership_id)}"> Apple Wallet</button><button class="fp-wallet" data-wallet="google" data-id="${escapeHtml(program.membership_id)}">Google Wallet</button></div></div>` : '';
    return `<article class="fp-program"><div class="fp-program-head"><p class="fp-program-name">${escapeHtml(program.card_name)}</p>${program.location_name ? `<p class="fp-location">${escapeHtml(program.location_name)}</p>` : ''}<div class="fp-balance"><strong>${value}</strong><span>${isPoints ? 'points' : `tampon${value > 1 ? 's' : ''} sur ${program.stamps_total}`}</span></div><div class="fp-progress" aria-label="Progression ${progress}%"><i style="width:${progress}%"></i></div></div>${rewardHtml}${historyHtml}${walletHtml}</article>`;
  }

  private accountView(): string {
    if (!this.account) return this.loginView();
    return `<div class="fp-welcome"><div><h2 class="fp-title">Bonjour ${escapeHtml(this.account.customer.first_name)}</h2><p class="fp-copy">Voici l’état de votre fidélité.</p></div><button class="fp-link" id="fp-logout" type="button">Déconnexion</button></div>${this.error ? `<p class="fp-error" role="alert">${escapeHtml(this.error)}</p>` : ''}${this.account.programs.length ? this.account.programs.map((program) => this.programView(program)).join('') : '<p class="fp-empty">Aucune carte active trouvée.</p>'}`;
  }

  private render() {
    this.root.innerHTML = `${this.styles()}${this.frame(this.config ? this.accountView() : `<p class="fp-error" role="alert">${escapeHtml(this.error || 'Widget indisponible.')}</p>`)}`;
    this.bindFrameEvents();
    this.bindContentEvents();
  }

  private bindFrameEvents() {
    this.root.querySelector('.fp-launcher')?.addEventListener('click', () => { this.opened = !this.opened; this.render(); });
    this.root.querySelector('.fp-close')?.addEventListener('click', () => { this.opened = false; this.render(); });
  }

  private bindContentEvents() {
    this.root.querySelector('#fp-phone-form')?.addEventListener('submit', (event) => void this.submitPhone(event));
    this.root.querySelector('#fp-code-form')?.addEventListener('submit', (event) => void this.submitCode(event));
    this.root.querySelector('#fp-back')?.addEventListener('click', () => { this.challengeId = ''; this.error = ''; this.render(); });
    this.root.querySelector('#fp-logout')?.addEventListener('click', () => void this.logout());
    this.root.querySelectorAll<HTMLButtonElement>('[data-wallet]').forEach((button) => button.addEventListener('click', () => void this.openWallet(button)));
  }

  private async submitPhone(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    this.phone = String(new FormData(form).get('phone') ?? '').trim();
    this.loading = true; this.error = ''; this.render();
    try {
      const data = await this.request<{ challenge_id: string }>('/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: this.phone }) });
      this.challengeId = data.challenge_id;
    } catch (error) { this.error = error instanceof Error ? error.message : 'Envoi impossible.'; }
    this.loading = false; this.render();
  }

  private async submitCode(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const code = String(new FormData(form).get('code') ?? '').trim();
    this.loading = true; this.error = ''; this.render();
    try {
      const data = await this.request<{ access_token: string }>('/auth/verify-code', { method: 'POST', body: JSON.stringify({ challenge_id: this.challengeId, phone: this.phone, code }) });
      this.token = data.access_token;
      this.challengeId = '';
      await this.loadAccount();
    } catch (error) { this.error = error instanceof Error ? error.message : 'Connexion impossible.'; }
    this.loading = false; this.render();
  }

  private async logout() {
    try { await this.request<JsonRecord>('/logout', { method: 'POST', body: '{}' }); } catch { /* Révocation locale garantie. */ }
    this.token = ''; this.account = null; this.challengeId = ''; this.error = ''; this.render();
  }

  private async openWallet(button: HTMLButtonElement) {
    const membershipId = button.dataset.id ?? '';
    const program = this.account?.programs.find((item) => item.membership_id === membershipId);
    if (!program) return;
    button.disabled = true;
    this.error = '';
    try {
      if (button.dataset.wallet === 'apple') {
        const response = await fetch(program.wallet.apple_url, { headers: { Authorization: `Bearer ${this.token}` } });
        if (!response.ok) throw new Error('Ajout à Apple Wallet impossible.');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = 'fidelite.pkpass'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } else {
        const response = await fetch(program.wallet.google_url, { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: '{}' });
        const payload = await response.json().catch(() => ({})) as { data?: { save_url?: string }; error?: string };
        if (!response.ok || !payload.data?.save_url) throw new Error(payload.error || 'Ajout à Google Wallet impossible.');
        window.open(payload.data.save_url, '_blank', 'noopener');
      }
    } catch (error) { this.error = error instanceof Error ? error.message : 'Wallet indisponible.'; }
    button.disabled = false; this.render();
  }
}

if (!customElements.get('fidelopass-loyalty')) customElements.define('fidelopass-loyalty', FidelopassLoyalty);

export { FidelopassLoyalty };
